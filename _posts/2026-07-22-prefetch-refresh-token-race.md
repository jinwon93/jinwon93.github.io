---
layout: post
title: "간헐 로그아웃의 범인은 prefetch였다 — refresh token 회전 경쟁 추적기"
date: 2026-07-22 14:00:00 +0900
categories: nextjs auth
tags: [Next.js, Supabase, 인증, refresh-token, 트러블슈팅]
---

실서버에서만 발생하는 버그가 제일 어렵다. 사용자가 **가끔 이유 없이 로그아웃**됐고,
로컬에서는 재현되지 않았다. Vercel 로그에는 `/api/auth/me` 401이 간헐적으로 몰려 있었다.
이 글은 그 범인을 찾아가는 과정의 기록이다.

## 전제: refresh token rotation

Supabase(대부분의 최신 인증 시스템도 동일)는 refresh token을 **1회용**으로 회전시킨다.
refresh를 하면 새 refresh token이 발급되고 이전 것은 무효화된다. 보안상 올바른 설계지만,
한 가지 함정이 있다 — **같은 refresh token으로 두 요청이 동시에 갱신을 시도하면
한쪽은 반드시 실패**하고, 타이밍이 나쁘면 세션 전체가 무효화된다.

## 추적: 누가 동시에 refresh를 하는가

로그를 시간순으로 늘어놓고 401 직전에 무슨 요청이 있었는지 봤다. 패턴이 보였다.
로그아웃 직전엔 항상 **여러 개의 RSC 요청이 거의 동시에** 들어와 있었다.
`?_rsc=` 파라미터 — Next.js의 **Link prefetch**였다.

그림이 그려졌다.

1. 사용자가 홈에 진입하면 사이드바의 메뉴 링크들이 **동시에 prefetch**된다
2. 각 prefetch 요청이 미들웨어를 통과하면서 **각자 세션 refresh를 시도**한다
3. 같은 refresh token으로 N개의 회전이 경쟁 → 실패한 요청이 세션을 무효화
4. 사용자는 아무것도 안 했는데 로그아웃

로컬에서 재현이 안 됐던 이유도 설명된다. 로컬은 지연이 작아 요청이 겹칠 틈이 없고,
실서버는 왕복 지연 동안 요청들이 겹친다.

## 해결: refresh는 한 곳에서만

원칙을 하나 세웠다. **"토큰 갱신은 시스템 전체에서 단 한 곳, 실제 내비게이션에서만 한다."**

- **미들웨어**: 실제 페이지 내비게이션만 `getUser()`로 refresh (내비게이션당 1회)
- **prefetch 요청**: 헤더로 구분해서 refresh 없는 **로컬 JWT 검증**(`getClaims()`)만 수행
- **API·RSC**: 마찬가지로 로컬 검증만 — 미들웨어가 갱신해둔 프레시 토큰을 공유

```ts
// 미들웨어 (개념 요약)
const isPrefetch =
  req.headers.get("next-router-prefetch") === "1" ||
  req.headers.get("purpose") === "prefetch";

if (isPrefetch) {
  await supabase.auth.getClaims();   // 로컬 검증만 — refresh 없음
} else {
  await supabase.auth.getUser();     // 유일한 refresh 지점
}
```

부수 효과도 컸다. 페이지 로드 한 번이 부르는 수십 개의 API가 저마다 하던
인증 서버 왕복이 사라지면서 **응답 지연도 함께 줄었다.**

## 마무리 디테일: 뒤로가기 로그아웃 오인

같은 시기에 "로그인했는데 뒤로가기를 누르면 로그인 페이지가 다시 나온다"는 제보도 있었다.
로그인 성공 후 `window.location.href`로 이동하면 로그인 페이지가 히스토리에 남는다.
`window.location.replace`로 바꿔 히스토리에서 제거 — 사용자가 로그아웃된 것으로
오인할 여지를 없앴다.

## 배운 것

- **"가끔" + "실서버에서만"** 조합은 높은 확률로 동시성 문제다. 지연이 경쟁 창을 만든다.
- 편의 기능(prefetch)이 인증 같은 상태 변경 경로를 지나가게 두면 안 된다.
  읽기 경로와 갱신 경로를 분리하자.
- 로그를 "에러 위주"가 아니라 **시간순 이야기**로 읽으면 원인이 보인다.
  401 자체가 아니라 401 *직전*이 단서였다.
