---
layout: post
title: "DDL은 복제되지 않는다 — 본 DB의 ALTER TABLE 한 줄에 멈춘 복제, 스스로 고치게 만들기"
date: 2026-08-04 18:00:00 +0900
categories: database postgresql
tags: [logical-replication, postgresql, supabase, schema-drift, fdw, incident]
---

지난주 논리복제 슬롯이 두 번 죽은 뒤 워치독을 붙였는데, 그 워치독이 이번 주 첫 실전을 치렀다.
17시부터 10분 간격으로 `apply_error` — 에러 카운터가 10분마다 정확히 120씩 늘고 있었다.
5초 재시도 간격의 크래시 루프라는 뜻이다. 레플리카 로그를 열어보니 원인은 한 줄이었다.

```
logical replication target relation "src.auto_order_grp" is missing
replicated column: "max_qty"
```

운영 DB에서 누군가 `ALTER TABLE ... ADD COLUMN max_qty`를 실행한 것이다. 논리복제는 WAL에서
**행 데이터만** 나른다. DDL은 복제되지 않는다 — 이건 버그가 아니라 PostgreSQL 스펙이다.
퍼블리셔가 새 컬럼을 포함한 행을 보내는 순간, 그 컬럼이 없는 구독자의 apply worker는 죽는다.
슬롯은 살아있으므로 WAL만 조용히 쌓인다. 30분 만에 랙이 79MB → 241MB. 상한이 4GB니까
반나절짜리 시한부다. 지난주와 같은 슬롯 사망 코스인데, 이번엔 워치독 덕에 30분 만에 알았다.

## 두 번째 시한폭탄

누락 컬럼이 하나뿐이라는 보장이 없었다. 복제 대상 127개 테이블, 2,275개 컬럼의 시그니처를
양쪽에서 덤프해 비교하는 건 결과물이 너무 크다. 대신 퍼블리셔에 "퍼블리케이션 대상 컬럼 카탈로그"
뷰를 하나 만들고, 레플리카에서 postgres_fdw로 그 뷰를 읽어 안티조인 한 방으로 끝냈다.

```sql
-- 퍼블리셔: 복제 대상 테이블의 컬럼 목록 (읽기 전용 뷰)
create view repl_column_catalog as
select n.nspname schema_name, c.relname table_name, a.attname column_name,
       format_type(a.atttypid, a.atttypmod) data_type, a.attnum
from pg_publication p
join pg_publication_rel pr on pr.prpubid = p.oid
join pg_class c on c.oid = pr.prrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
                   and not a.attisdropped
                   and a.attgenerated = '';  -- 생성 컬럼은 애초에 복제 안 됨

-- 레플리카: 퍼블리셔에는 있는데 나에게 없는 컬럼만
select f.table_name, f.column_name, f.data_type
from pubsrc.repl_column_catalog f
where not exists (select 1 from pg_attribute a ... );
```

결과는 2건. 방금 터진 `max_qty` 말고 `order_arr`라는 컬럼이 하나 더 있었다. 아직 그 테이블에
쓰기가 없어서 안 터졌을 뿐, 첫 UPDATE가 들어오는 순간 터질 예정이던 두 번째 시한폭탄이다.
전수 비교를 안 했으면 하나 고치고 며칠 뒤 같은 장애를 또 겪었을 것이다.

## 복구, 그리고 함정 둘

레플리카에 `ADD COLUMN` 두 번. apply worker는 5초 뒤 재시도에서 살아났고, 밀렸던 241MB를
1분 만에 소화했다. 이번엔 슬롯이 살아있었으므로 정지 구간의 변경분이 전부 WAL에 남아
순서대로 재생됐다 — 데이터 손실 0. 지난주의 슬롯 사망(`wal_status=lost`, 비가역)과는
등급이 다른 장애다. 다만 함정이 둘 있었다.

하나, **컬럼 추가 "이전"부터 있던 행들**. 소스에서 기존 행에 값이 채워져 있어도, 그 행이 다시
UPDATE되기 전까지 레플리카의 새 컬럼은 NULL이다. 복제는 변경분만 나르니까. FDW로 소스에서
해당 컬럼만 조인 백필해서 diff 0을 확인했다.

둘, **하류 증분 동기화의 워터마크**. 통계 DB로 가는 5분 증분 동기화는 "지난 실행 이후 변경분"을
타임스탬프 워터마크로 끊는데, 복제가 멈춘 동안에도 크론은 0건 success를 찍으며 워터마크를
전진시켰다. 복제가 복구되자 정지 구간의 행들은 워터마크보다 "과거" 타임스탬프로 도착했고,
그대로면 영영 동기화되지 않는다. 명시적 `since` 파라미터로 정지 시각부터 재수집해 30분 구멍을 메웠다.

## 매번 수동으로 할 수는 없다

여기까지가 복구고, 진짜 질문은 "본 DB에 컬럼이 추가될 때마다 이 짓을 반복해야 하나"였다.
답은 위의 진단 쿼리를 그대로 워치독에 넣는 것이다. 어차피 10분마다 FDW로 슬롯 상태를 읽고
있으니, 같은 사이클에서 컬럼 diff를 뜨고 누락분을 즉시 적용한다.

```sql
for r in (select ... from pubsrc.repl_column_catalog f
          where not exists ( ...레플리카에 없는 컬럼... ))
loop
  execute format('alter table src.%I add column if not exists %I %s',
                 r.table_name, r.column_name, r.data_type);
end loop;
```

설계에서 지킨 경계선:

- **추가만 자동, 나머지는 보고만.** 컬럼 추가는 nullable로 넣는 한 무해하다(복제는 제약 동등성을
  요구하지 않는다). 반면 테이블 신설·타입 변경·컬럼 삭제는 자동으로 손대면 더 큰 사고가 되므로
  `schema_drift` 이벤트로 기록만 하고 사람을 부른다.
- **타입 문자열 화이트리스트.** 동적 DDL에 들어가는 타입 문자열은 카탈로그 출신이지만,
  `%I` 식별자 인용에 더해 `^[a-zA-Z0-9_" (),\[\].]+$` 검증을 통과한 것만 실행한다.
- **워치독 판정 우선순위에 편입.** 스키마 점검을 상태 판정보다 먼저 돌린다. 그러면 apply 에러가
  진행 중이어도 "누락 컬럼 자동 추가됨 — 수 초 내 복구 예상"이라는 정확한 이벤트가 남는다.
  이전 워치독은 이번 장애를 "제약 충돌 추정"으로 오분류했다 — 에러 카운터 증가만 보면 원인을
  구분할 수 없다. 원인 계층(슬롯 → 스키마 → 제약 → 워커 → 랙) 순서로 점검해야 한다.

배포 전에 실전 테스트도 했다. 레플리카에서 문제의 컬럼을 일부러 drop하고 워치독을 한 번
돌리자, 같은 사이클 안에서 감지 → 재추가 → `schema_synced` 로그까지 확인됐다. 이제 본 DB의
`ADD COLUMN`은 최대 10분 안에 레플리카가 스스로 따라간다. WAL 여유가 4GB니 10분 랙은
오차 범위다. 운이 좋으면 새 컬럼에 첫 쓰기가 들어오기 전에 선제 적용돼 크래시 자체가 없다.

## 배운 것

- 논리복제에서 DDL 미복제는 스펙이다. 소스 스키마가 살아있는 시스템이라면 스키마 드리프트는
  "만약"이 아니라 "언제"의 문제고, 감시 없이는 첫 쓰기 시점에 크래시로 발견하게 된다.
- 하나 터졌으면 전수를 봐야 한다. 같은 원인의 두 번째 폭탄(`order_arr`)은 아직 안 터졌을 뿐이었다.
  진단 쿼리는 "터진 것"이 아니라 "터질 수 있는 것 전부"를 찾도록 짜야 한다.
- 슬롯이 살아있는 정지는 손실 없이 재생되지만, 복구로 끝이 아니다. 컬럼 추가 이전 행의 NULL 백필,
  그리고 정지 중에도 전진한 하류 워터마크 — 파이프라인의 다음 단까지 정합을 확인해야 한다.
- 자동 치유는 경계선이 생명이다. 무해가 증명되는 연산(nullable ADD COLUMN)만 자동으로,
  판단이 필요한 연산은 정확한 진단과 함께 사람에게. 그리고 자동화는 배포 전에 장애를 재현해서
  한 사이클 안에 고치는 걸 눈으로 확인하고 내보낸다.
