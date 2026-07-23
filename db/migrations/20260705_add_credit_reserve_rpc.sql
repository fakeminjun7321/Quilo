-- 크레딧 무결성(P1: H2/M1/M2/M3) — 원자적 크레딧 RPC 일괄.
-- 목적:
--  (1) reserve_credits: 생성 '전' 원자적 선차감(잔액 부족 시 거부, 0으로 바닥 처리 안 함).
--      → check-then-spend TOCTOU / 동시 이중지불 / floor-at-0 무료생성을 막는다.
--  (2) add_credits: 환불·충전·프리미엄 지급을 원자적으로(비원자 read-modify-write 제거).
--  (3) spend_credits / deduct_credit: 기존 hand-run(db/credit-rpc.sql)을 numbered migration
--      으로 정식 배포(M1). 이미 실행돼 있어도 create or replace 라 안전.
--
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run. idempotent.
-- 코드는 이 함수들이 없어도 동작(레거시 후불·비원자 폴백)하므로 배포/실행 순서 무관.

-- (1) 원자적 예약(선차감) --------------------------------------------------------
-- 성공: 차감 후 새 잔액(>=0). 잔액 부족: -1. 사용자 없음: 예외.
create or replace function reserve_credits(
  p_user_id text,
  p_amount integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_balance integer;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid amount: %', p_amount;
  end if;

  if p_amount = 0 then
    select credits into new_balance from public.users where id::text = p_user_id;
    if new_balance is null then
      raise exception 'user not found: %', p_user_id;
    end if;
    return new_balance;
  end if;

  update public.users
    set credits = coalesce(credits, 0) - p_amount
    where id::text = p_user_id and coalesce(credits, 0) >= p_amount
    returning credits into new_balance;

  if new_balance is null then
    if not exists (select 1 from public.users where id::text = p_user_id) then
      raise exception 'user not found: %', p_user_id;
    end if;
    return -1; -- 잔액 부족
  end if;

  return new_balance;
end;
$$;

revoke all on function public.reserve_credits(text, integer) from public, anon, authenticated;
grant execute on function public.reserve_credits(text, integer) to service_role;

-- (2) 원자적 충전/환불 ----------------------------------------------------------
create or replace function add_credits(
  p_user_id text,
  p_amount integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_balance integer;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid amount: %', p_amount;
  end if;

  update public.users
    set credits = coalesce(credits, 0) + p_amount
    where id::text = p_user_id
    returning credits into new_balance;

  if new_balance is null then
    raise exception 'user not found: %', p_user_id;
  end if;

  return new_balance;
end;
$$;

revoke all on function public.add_credits(text, integer) from public, anon, authenticated;
grant execute on function public.add_credits(text, integer) to service_role;

-- (3) 기존 원자 RPC 정식 배포(M1) — db/credit-rpc.sql 과 동일 정의 -----------------
create or replace function spend_credits(
  p_user_id text,
  p_amount integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_balance integer;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid amount: %', p_amount;
  end if;

  update public.users
    set credits = greatest(coalesce(credits, 0) - p_amount, 0)
    where id::text = p_user_id
    returning credits into new_balance;

  if new_balance is null then
    raise exception 'user not found: %', p_user_id;
  end if;

  return new_balance;
end;
$$;

revoke all on function public.spend_credits(text, integer) from public, anon, authenticated;
grant execute on function public.spend_credits(text, integer) to service_role;

create or replace function deduct_credit(
  p_user_id text,
  p_col text,
  p_amount numeric
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_balance numeric;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'invalid amount: %', p_amount;
  end if;

  if p_col = 'pre_credits_usd' then
    update public.users
      set pre_credits_usd = greatest(coalesce(pre_credits_usd, 0) - p_amount, 0)
      where id::text = p_user_id
      returning pre_credits_usd into new_balance;
  elsif p_col = 'result_credits_usd' then
    update public.users
      set result_credits_usd = greatest(coalesce(result_credits_usd, 0) - p_amount, 0)
      where id::text = p_user_id
      returning result_credits_usd into new_balance;
  else
    raise exception 'invalid credit column: %', p_col;
  end if;

  if new_balance is null then
    raise exception 'user not found: %', p_user_id;
  end if;

  return new_balance;
end;
$$;

revoke all on function public.deduct_credit(text, text, numeric) from public, anon, authenticated;
grant execute on function public.deduct_credit(text, text, numeric) to service_role;

-- (4) 원자적 통계 누적(L3) — users.spent_usd 를 lost-update 없이 더한다 ------------
create or replace function add_spent_usd(
  p_user_id text,
  p_amount numeric
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_spent numeric;
begin
  if p_amount is null then
    raise exception 'invalid amount: %', p_amount;
  end if;

  update public.users
    set spent_usd = coalesce(spent_usd, 0) + p_amount
    where id::text = p_user_id
    returning spent_usd into new_spent;

  if new_spent is null then
    raise exception 'user not found: %', p_user_id;
  end if;

  return new_spent;
end;
$$;

revoke all on function public.add_spent_usd(text, numeric) from public, anon, authenticated;
grant execute on function public.add_spent_usd(text, numeric) to service_role;
