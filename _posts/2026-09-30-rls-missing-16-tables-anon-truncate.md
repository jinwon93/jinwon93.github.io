---
layout: post
title: "공개 키로 TRUNCATE까지 되던 테이블 16개 — 'RLS 한 줄'을 빠뜨리기 가장 쉬운 곳"
date: 2026-09-30 09:30:00 +0900
categories: database security
tags: [supabase, postgresql, rls, security, postgrest]
---

Supabase에서 보안 경고 메일이 왔다. 제목은 "These issues require your immediate attention",
항목은 `rls_disabled_in_public` — "프로젝트 URL을 아는 누구나 이 테이블의 모든 데이터를 읽고, 수정하고,
지울 수 있다." 통계 DB는 전 테이블에 RLS를 켜 두는 게 원칙이라 처음엔 오탐이라고 생각했다.

오탐이 아니었다.

## 추적

API로 노출되는 스키마(앱이 스키마를 지정해 호출하는 두 개)에서 RLS 상태를 전수 조회했다.

```sql
select n.nspname || '.' || c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('metadata', 'reporting') and c.relkind = 'r'
   and not c.relrowsecurity;
```

16개가 나왔다. 다음으로 그 테이블에 누가 무슨 권한을 갖고 있는지 봤다.

```sql
select table_name, grantee, string_agg(privilege_type, ',')
  from information_schema.role_table_grants
 where grantee in ('anon', 'authenticated') and table_name = any(:rls_off_tables)
 group by 1, 2;
```

`anon`에 **SELECT, INSERT, UPDATE, DELETE, TRUNCATE** 전권이 있었다. `anon` 키는 브라우저 번들에
들어가는 공개 키다. 개발자 도구만 열면 누구나 매장정보 제안 테이블을 통째로 비울 수 있는 상태였다.

기존 96개 테이블은 멀쩡했다. 빠진 16개의 공통점은 **전부 최근 한 달 안에 만든 것**이었다.

| 종류 | 개수 | 예 |
|---|---|---|
| 백업 테이블 | 10 | 데이터 정리 작업 직전 원본을 떠 둔 `*_backup_YYYYMMDD` |
| 제안·감시·매핑 테이블 | 6 | 자동 채움 제안, 봉인 컬럼 대장, 복제 통계 스냅샷 |

Supabase는 새 테이블에 `anon`·`authenticated` 권한을 기본으로 준다. 그래서 `create table` 뒤에
`enable row level security` 한 줄을 빠뜨리면 그 순간 열린다. 그리고 그 한 줄을 가장 빠뜨리기 쉬운 곳이
"잠깐 쓰고 말" 백업·임시 테이블이다. 급하게 데이터를 정리하기 직전에, 원본을 떠 두느라 만든 것들이다.

## 해결

앱은 서버에서 `service_role`로만 DB에 접근한다. `service_role`은 RLS를 우회하므로,
**RLS를 켜고 정책을 하나도 두지 않으면** 앱에는 영향 없이 공개 키만 완전히 막힌다.

```sql
alter table 스키마.제안테이블 enable row level security;
-- … 16개 동일
```

켜기 전에 확인한 것 하나 — 공개 키 클라이언트가 직접 `.from()`으로 테이블을 읽는 곳을 코드에서 전수 찾았다.
사용자 테이블과 로그인 이력 두 곳뿐이었고, 이번 16개와는 겹치지 않았다. 적용 후 서버 경로의 조회도 정상이었다.

| 스키마 | 테이블 | RLS 적용 |
|---|---|---|
| metadata | 64 | **64 / 64** |
| reporting | 58 | **58 / 58** |

## 스캐너보다 먼저 알기

이번엔 외부 스캐너 메일로 알았다. 그 메일이 오기 전까지 이 구멍이 얼마나 열려 있었는지는 모른다.
같은 실수는 다음 백업 테이블에서 또 나올 테니, 매일 아침 노출 스키마에서 RLS 꺼진 테이블을 찾아
슬랙으로 알리는 감시를 붙였다. 알림엔 고치는 한 줄과, 백업이면 노출 스키마 밖으로 옮기라는 안내를 같이 넣었다.

백업 10개는 RLS로 잠갔지만 근본적으로는 API 노출 스키마에 있을 이유가 없다.
다만 "복원 불가 정보의 유일한 보관처"인 것들이 있어 이동은 따로 진행하기로 했다.

## 배운 것

- **기본값이 열려 있는 플랫폼에선 "만들 때 잠근다"를 사람의 기억에 맡기면 안 된다.** 96번 지키고 16번 빠뜨렸다. 기억은 확률이다.
- **백업·임시 테이블이 가장 위험하다.** 급할 때, 금방 지울 생각으로 만든다. 그래서 가장 대충 만들고 가장 오래 남는다.
- **서버만 DB에 접근하는 구조라면 "RLS 켜고 정책 없음"이 가장 안전한 기본값이다.** 정책을 설계할 필요도 없이 공개 경로만 닫힌다.
- **외부 스캐너가 알려주는 건 이미 열려 있던 시간의 끝이다.** 같은 검사를 우리 쪽 주기로 돌려야 그 시간을 줄인다.
