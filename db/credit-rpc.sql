-- 원자적 크레딧 차감 RPC
-- ---------------------------------------------------------------------------
-- 목적: 동시 요청에서도 잃어버린 갱신(lost update)·이중 차감 없이 잔액을 깎는다.
-- 단일 `UPDATE ... RETURNING`이라 행 수준 잠금으로 직렬화된다.
--
-- 적용: Supabase 대시보드 → SQL Editor에 아래 전체를 붙여넣고 한 번 실행.
-- 적용 후 lib/supabase.js의 deductCredit()이 이 함수를 우선 사용한다.
-- (함수가 없으면 코드가 기존 비원자 read-modify-write로 자동 폴백하므로,
--  실행 전에도 서비스는 동작한다 — 다만 동시성 보호는 없음.)
--
-- p_user_id 는 users.id 타입(uuid/text)에 상관없이 동작하도록 text로 받는다.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 통합 크레딧 포인트(정수) 원자적 차감 RPC
-- 모델별 과금(Opus 3 / Sonnet 1)으로 전환한 새 크레딧제용.
-- lib/supabase.js의 spendCredits()가 우선 사용, 없으면 read-modify-write 폴백.
-- ---------------------------------------------------------------------------
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
