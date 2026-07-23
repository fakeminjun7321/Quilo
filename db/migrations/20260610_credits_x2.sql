-- 크레딧 단가 개편(2026-06-10)에 따른 기존 잔액 가치 보존 보정.
--
-- 단가가 Sonnet 1→2 스케일로 바뀌었으므로(mini 0 / GPT-5.4 1 / Sonnet 2 /
-- GPT-5.5·Opus 4 / Fable 9), 기존 잔액을 ×2 해야 "Sonnet 기준 남은 건수"가 유지된다.
-- ⚠️ 새 코드 배포와 같은 시점에 1회만 실행할 것 (두 번 실행하면 ×4가 됨).

UPDATE users SET credits = credits * 2 WHERE credits > 0;
