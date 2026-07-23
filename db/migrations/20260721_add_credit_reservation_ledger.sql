-- 크레딧 예약 내구성: 서버 재시작·네트워크 재시도에도 예약/정산/환불을 정확히 한 번만 처리한다.
-- 기존 reserve_credits RPC는 차감 사실을 남기지 않아 프로세스가 종료되면 환불할 수 없었다.
-- 아래 ledger와 RPC는 잔액 변경과 상태 기록을 같은 DB transaction에서 수행한다.

create table if not exists credit_reservations (
  job_id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  reserved_amount integer not null check (reserved_amount > 0),
  settled_amount integer check (settled_amount is null or settled_amount >= 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'settled', 'refunded')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists credit_reservations_stale_idx
  on credit_reservations (expires_at)
  where status = 'reserved';

alter table credit_reservations enable row level security;
revoke all on table credit_reservations from public, anon, authenticated;
grant select, insert, update, delete on table credit_reservations to service_role;

create or replace function reserve_generation_credits(
  p_job_id text,
  p_user_id text,
  p_amount integer,
  p_ttl_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing credit_reservations%rowtype;
  target_user_id uuid;
  new_balance integer;
  ttl_seconds integer;
begin
  if nullif(btrim(p_job_id), '') is null or length(p_job_id) > 200 then
    raise exception 'invalid job id';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount: %', p_amount;
  end if;
  ttl_seconds := greatest(300, least(coalesce(p_ttl_seconds, 3600), 21600));

  select * into existing
    from public.credit_reservations
    where job_id = p_job_id
    for update;
  if found then
    if existing.user_id::text <> p_user_id or existing.reserved_amount <> p_amount then
      raise exception 'reservation idempotency conflict: %', p_job_id;
    end if;
    if existing.status <> 'reserved' then
      raise exception 'reservation already closed: %', p_job_id;
    end if;
    update public.credit_reservations
      set expires_at = greatest(expires_at, now() + make_interval(secs => ttl_seconds)),
          updated_at = now()
      where job_id = p_job_id;
    select credits into new_balance from public.users where id = existing.user_id;
    if new_balance is null then raise exception 'user not found: %', p_user_id; end if;
    return new_balance;
  end if;

  select id into target_user_id from public.users where id::text = p_user_id;
  if target_user_id is null then raise exception 'user not found: %', p_user_id; end if;

  update public.users
    set credits = coalesce(credits, 0) - p_amount
    where id = target_user_id and coalesce(credits, 0) >= p_amount
    returning credits into new_balance;
  if new_balance is null then return -1; end if;

  insert into public.credit_reservations (
    job_id, user_id, reserved_amount, status, expires_at
  ) values (
    p_job_id,
    target_user_id,
    p_amount,
    'reserved',
    now() + make_interval(secs => ttl_seconds)
  );
  return new_balance;
end;
$$;

create or replace function touch_generation_credit_reservation(
  p_job_id text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  touched_rows integer;
  ttl_seconds integer;
begin
  ttl_seconds := greatest(300, least(coalesce(p_ttl_seconds, 3600), 21600));
  update public.credit_reservations
    set expires_at = now() + make_interval(secs => ttl_seconds),
        updated_at = now()
    where job_id = p_job_id and status = 'reserved';
  get diagnostics touched_rows = row_count;
  return touched_rows > 0;
end;
$$;

create or replace function settle_generation_credit_reservation(
  p_job_id text,
  p_spent integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reservation credit_reservations%rowtype;
  adjustment integer;
  new_balance integer;
begin
  if p_spent is null or p_spent < 0 then
    raise exception 'invalid spent amount: %', p_spent;
  end if;
  select * into reservation
    from public.credit_reservations
    where job_id = p_job_id
    for update;
  if not found then raise exception 'reservation not found: %', p_job_id; end if;

  if reservation.status = 'settled' then
    if reservation.settled_amount <> p_spent then
      raise exception 'settlement idempotency conflict: %', p_job_id;
    end if;
    select credits into new_balance from public.users where id = reservation.user_id;
    return jsonb_build_object('balance', new_balance, 'status', 'settled', 'changed', false);
  elsif reservation.status = 'refunded' then
    raise exception 'reservation already refunded: %', p_job_id;
  end if;

  adjustment := reservation.reserved_amount - p_spent;
  if adjustment >= 0 then
    update public.users
      set credits = coalesce(credits, 0) + adjustment
      where id = reservation.user_id
      returning credits into new_balance;
  else
    update public.users
      set credits = coalesce(credits, 0) + adjustment
      where id = reservation.user_id
        and coalesce(credits, 0) >= -adjustment
      returning credits into new_balance;
    if new_balance is null then
      raise exception 'insufficient credits for settlement overage: %', p_job_id;
    end if;
  end if;
  if new_balance is null then raise exception 'user not found for reservation: %', p_job_id; end if;

  update public.credit_reservations
    set status = 'settled', settled_amount = p_spent,
        updated_at = now(), closed_at = now()
    where job_id = p_job_id;
  return jsonb_build_object('balance', new_balance, 'status', 'settled', 'changed', true);
end;
$$;

create or replace function refund_generation_credit_reservation(p_job_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reservation credit_reservations%rowtype;
  new_balance integer;
begin
  select * into reservation
    from public.credit_reservations
    where job_id = p_job_id
    for update;
  if not found then raise exception 'reservation not found: %', p_job_id; end if;

  if reservation.status in ('refunded', 'settled') then
    select credits into new_balance from public.users where id = reservation.user_id;
    return jsonb_build_object(
      'balance', new_balance,
      'status', reservation.status,
      'changed', false
    );
  end if;

  update public.users
    set credits = coalesce(credits, 0) + reservation.reserved_amount
    where id = reservation.user_id
    returning credits into new_balance;
  if new_balance is null then raise exception 'user not found for reservation: %', p_job_id; end if;

  update public.credit_reservations
    set status = 'refunded', settled_amount = 0,
        updated_at = now(), closed_at = now()
    where job_id = p_job_id;
  return jsonb_build_object('balance', new_balance, 'status', 'refunded', 'changed', true);
end;
$$;

create or replace function refund_stale_generation_credit_reservations(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reservation record;
  refunded_count integer := 0;
begin
  for reservation in
    select job_id
      from public.credit_reservations
      where status = 'reserved' and expires_at <= now()
      order by expires_at asc
      limit greatest(1, least(coalesce(p_limit, 500), 5000))
      for update skip locked
  loop
    perform public.refund_generation_credit_reservation(reservation.job_id);
    refunded_count := refunded_count + 1;
  end loop;
  return refunded_count;
end;
$$;

revoke all on function public.reserve_generation_credits(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.touch_generation_credit_reservation(text, integer) from public, anon, authenticated;
revoke all on function public.settle_generation_credit_reservation(text, integer) from public, anon, authenticated;
revoke all on function public.refund_generation_credit_reservation(text) from public, anon, authenticated;
revoke all on function public.refund_stale_generation_credit_reservations(integer) from public, anon, authenticated;
grant execute on function public.reserve_generation_credits(text, text, integer, integer) to service_role;
grant execute on function public.touch_generation_credit_reservation(text, integer) to service_role;
grant execute on function public.settle_generation_credit_reservation(text, integer) to service_role;
grant execute on function public.refund_generation_credit_reservation(text) to service_role;
grant execute on function public.refund_stale_generation_credit_reservations(integer) to service_role;
