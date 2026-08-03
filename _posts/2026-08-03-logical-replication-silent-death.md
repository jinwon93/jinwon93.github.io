---
layout: post
title: "논리복제가 에러 한 줄 없이 두 번 죽었다 — 범인은 매일 아침 2,200만 행을 통갈이하던 백업 배치"
date: 2026-08-03 10:30:00 +0900
categories: database postgresql
tags: [logical-replication, postgresql, supabase, wal, incident]
---

월요일 아침 통계 대시보드의 활성 매장 지표가 -81.3%로 꽂혀 있었다. 주말 이틀치 실매장 데이터가 통째로 없었다.
파이프라인은 운영 DB(POS) → 논리복제 → 레플리카 → 5분 증분 동기화 → 통계 DB 구조인데,
증분 동기화 로그를 보니 크론은 5분마다 성실하게 `success`를 찍으면서 **수집량만 0건**이었다.
같은 장애가 나흘 전에도 한 번 있었다. 그때는 22시간, 이번엔 주말 내내 아무도 몰랐다.

## 추적

레플리카에서 `pg_stat_subscription`을 보니 apply worker의 pid가 비어 있었다. 로그에는 5초 간격으로
`cannot read from logical replication slot` — 퍼블리셔의 슬롯이 무효화(invalidated)된 상태였다.

```sql
select slot_name, active, wal_status from pg_replication_slots;
-- yesir_order_slot | f | lost
```

`wal_status = lost`는 복구 불가다. 구독자가 WAL을 소비하지 못하는 동안 보존량이
`max_slot_wal_keep_size`(이 환경은 4GB)를 넘으면 퍼블리셔가 슬롯을 무효화해 버린다.
실측 WAL 생성 속도가 시간당 약 480MB였으니, 전송이 멈추면 8~14시간 만에 슬롯이 죽는 구조였다.

문제는 "왜 멈췄는가"였다. 두 번 모두 타임아웃도, 커넥션 에러도 없이 **조용히** 멈췄다.
`apply_error_count`를 5초 재시도 간격으로 역산해 정지 시각을 좁히니 두 번째 사고는 06시 전후 —
운영 DB의 일 배치 시간과 겹쳤다. 배치 이력 테이블을 조회하자 그림이 맞아떨어졌다.

```sql
select bat_nm, st_de, ed_de - st_de as duration
from batch_history where st_de between '...05:30' and '...06:30';
-- 데이터백업 배치: 평소 15~40초, 사고 당일(월초)만 1분 52초
```

이 백업 배치가 뭘 하는지 `pg_stat_all_tables`로 확인하니 — 백업용 `bak_*` 테이블 20여 개를
**매일 전체 삭제 후 재삽입**하고 있었다. 가장 큰 테이블 하나가 매일 631만 행 삭제 + 631만 행 삽입
(누적 insert 5.7억 행, 보유 631만 행), 전체 합산 **하루 약 2,200만 건의 변경**이었다.

그리고 퍼블리케이션이 `FOR TABLES IN SCHEMA`로 잡혀 있어서, 이 백업 테이블들이 **전부 복제 대상**이었다.
통계용 레플리카에는 아무 쓸모없는 데이터인데, 소형 인스턴스인 레플리카가 매일 아침 이 폭격을 받아
적용하고 있었던 것이다. 평상시엔 몇 분 만에 소화했지만(동기화 로그로 확인), 월초에 배치가 3~7배
커진 날 끝내 얹혔고, 정지 → WAL 누적 → 4GB 초과 → 슬롯 사망으로 이어졌다.

첫 번째 사고는 변형이었다. 임시 테이블 통갈이가 `TRUNCATE` 방식이었는데 퍼블리케이션이
`pubtruncate = true`라 TRUNCATE도 복제된다. TRUNCATE 적용에는 대상 테이블의 ACCESS EXCLUSIVE 락이
필요한데, 마침 레플리카에 GUI 툴이 남긴 `idle in transaction` 세션(실측 36분짜리)이 락을 쥐고 있었다.
`lock_timeout = 0`이라 apply worker는 에러 없이 무한 대기 — 겉에서 보면 "연결은 살아있는데
데이터만 안 오는" 상태가 된다.

## 해결

원인이 "복제할 필요 없는 트래픽"이었으므로 수술도 거기에 했다. 스키마 단위 퍼블리케이션을
한 트랜잭션 안에서 명시 테이블 목록으로 원자 전환하며 백업·임시·이력 테이블 86개를 제외했다(213 → 127개).

```sql
begin;  -- 두 DDL 사이에 공백이 생기지 않도록 원자 실행
alter publication order_pub drop tables in schema src;
alter publication order_pub add table src.orders, src.order_items, ...;  -- 127개
commit;
-- 레플리카에서:
alter subscription order_sub refresh publication with (copy_data = false);
```

메타데이터 변경뿐이라 무중단이고, 운영 DB의 백업 배치 자체는 그대로 돈다. 결과물이 복제를 안 탈 뿐이다.
추가로 레플리카에 `idle_in_transaction_session_timeout = 10min`을 걸어 좀비 락 시나리오를 막고,
퍼블리셔 슬롯 랙을 FDW로 10분마다 감시하다가 2GB(상한의 절반)에서 구독을 자동 재시작하는
워치독을 pg_cron으로 붙였다. 감시 지표도 "잡이 성공했는가"에서 "**행이 실제로 들어왔는가**"로 바꿨다 —
증분 동기화는 0건을 가져와도 success를 찍기 때문에, 기존 감시로는 22시간 장애가 보이지 않았다.

| 항목 | 사고 전 | 조치 후 |
|---|---|---|
| 복제 대상 테이블 | 213개 (백업·임시 포함) | 127개 (운영 테이블만) |
| 일일 복제 변경량 | 실주문 + 통갈이 ~2,200만 건 | 실주문분만 |
| 정지 감지 | 불가 (success만 확인) | 30분 내 (row_count 기준) + 랙 2GB 자동 개입 |
| 슬롯 사망까지 여유 | 8~14시간 | 정지 원인 자체 제거 + 워치독 |

## 배운 것

- `FOR TABLES IN SCHEMA` 퍼블리케이션은 편하지만, 스키마에 백업·임시 테이블이 섞여 있으면
  무의미한 트래픽이 복제 대역폭과 레플리카 apply를 잠식한다. 복제 목록은 명시가 안전하다.
- 논리복제는 에러를 내고 죽지 않는다. 거대 트랜잭션 적용 지연도, 락 대기도 겉에서는
  "연결 정상 + 진행 없음"이다. 감시는 연결 상태가 아니라 **데이터 도착 여부**를 봐야 한다.
- 슬롯 무효화(`wal_status = lost`)는 비가역이다. `max_slot_wal_keep_size`는 장애 시
  "복구할 시간"을 사는 보험이므로, WAL 생성 속도 × 대응 가능 시간으로 역산해 잡아야 한다.
- 복제되는 TRUNCATE + 레플리카의 방치된 idle-in-transaction 세션 조합은 무한 락 대기를 만든다.
  레플리카에는 `idle_in_transaction_session_timeout`을 걸어두는 편이 좋다.
