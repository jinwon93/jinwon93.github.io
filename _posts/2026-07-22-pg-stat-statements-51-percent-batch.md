---
layout: post
title: "DB 실행시간의 51%를 잡아먹던 배치를 찾아낸 과정"
date: 2026-07-22 10:00:00 +0900
categories: postgresql performance
tags: [PostgreSQL, pg_stat_statements, 성능튜닝, Supabase]
---

운영 중인 통계 대시보드에서 이상한 패턴이 보였다. 평소엔 1초 안에 뜨던 메뉴 랭킹 쿼리가
**가끔씩만 6초 넘게** 걸렸다. 같은 쿼리, 같은 파라미터인데도. 이 글은 그 "가끔"의 원인을
데이터로 추적한 기록이다.

## 증상: 재현되지 않는 스파이크

느린 쿼리 튜닝의 첫 반응은 보통 "인덱스를 보자"다. 실행계획을 확인했다.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT ... FROM analytics_menu_daily WHERE ...;
```

결과는 이미 **index-only scan**. 웜 상태에서 0.8초 수준으로, 인덱스로는 더 할 게 없었다.
그런데도 특정 시점엔 6.6초. 쿼리 자체의 문제가 아니라면, **쿼리 바깥**에 원인이 있다는 뜻이다.

## 용의자 수색: pg_stat_statements

전체 DB에서 시간을 가장 많이 쓰는 게 누군지부터 확인했다.

```sql
SELECT
  round(total_exec_time::numeric, 0)  AS total_ms,
  calls,
  round(mean_exec_time::numeric, 1)   AS mean_ms,
  round(100 * total_exec_time / sum(total_exec_time) OVER (), 1) AS pct,
  left(query, 80)                     AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

1위가 압도적이었다. 매시간 도는 헬스체크성 배치 함수 하나가 **전체 DB 실행시간의 약 51%**를
차지하고 있었다. 실행당 17초. 내용을 뜯어보니 고아 데이터 검증용 안티조인이 raw 테이블을
풀스캔하고 있었고, `work_mem`을 크게 잡은 채 대량의 버퍼를 읽었다.

## 연결고리: 버퍼 캐시 eviction

여기서 두 사실이 연결된다.

1. 헬스체크 배치는 **매시간** 실행되며 raw 테이블을 대량 스캔한다
2. 대시보드 쿼리는 **가끔** 콜드 상태처럼 느려진다

배치가 raw 테이블을 훑고 지나가면, shared buffers에 올라와 있던 대시보드용
집계 테이블·인덱스 페이지가 **밀려난다(eviction)**. 직후에 들어온 대시보드 쿼리는
디스크에서 다시 읽어야 하니 콜드 스파이크가 된다. "가끔"의 정체는 배치 직후였던 것이다.

`EXPLAIN (ANALYZE, BUFFERS)`의 `shared read` 수치가 배치 직후에만 튀는 것으로 확인을 마쳤다.

## 해결: 인덱스가 아니라 스케줄

원인이 경합이니 해법도 경합 제거다.

- 헬스체크 배치를 **매시간 → 1일 1회, 최저 트래픽 시간대**로 재스케줄링
- 빠른 이상 감지가 필요한 항목은 이미 10분 주기의 가벼운 실패 감시가 담당하고 있어 안전
- 되돌릴 수 있게 migration에 원복 주석 포함

결과:

| 지표 | 전 | 후 |
|---|---|---|
| 배경 DB 부하 (배치 점유) | ~51% | 사실상 제거 |
| 대시보드 콜드 스파이크 | 최대 6.6s | ~0.8s (웜 수준) |
| 추가 인덱스 | — | 불필요 |

## 배운 것

- **느린 쿼리의 원인이 그 쿼리가 아닐 수 있다.** 실행계획이 깨끗한데 느리다면 주변을 보자.
- `pg_stat_statements`는 "누가 시간을 쓰는가"를 보는 가장 빠른 도구다. 튜닝 전 항상 여기서 시작한다.
- 인덱스 추가는 마지막 수단이다. 이번 건은 인덱스 0개 추가로 해결됐다.
- 스케줄 변경 같은 "시시한" 해법도 수치로 증명되면 가장 좋은 해법이다.
