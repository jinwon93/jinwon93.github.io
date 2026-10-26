---
layout: post
title: "멀티 에이전트 도구 Ruflo를 붙였더니 도구 379개가 따라왔다 — 그리고 설치 점검이 평문 토큰을 찾아냈다"
date: 2026-10-26 10:00:00 +0900
categories: tooling ai
tags: [claude-code, ruflo, mcp, multi-agent, git, github-cli, credential, security]
---

Claude Code에 멀티 에이전트 오케스트레이션 도구 Ruflo(구 claude-flow)를 붙였다.
설치는 `init` 한 줄로 끝났고, 진단 명령 `ruflo doctor`는 25개 통과·경고 9개·실패 0개를 냈다.
그런데 설치 상태를 하나씩 확인하다 보니, 정작 성과는 Ruflo 기능이 아니라 그 과정에서 드러난 것들이었다.
같은 서버가 두 번 등록돼 있었고, 세션마다 도구 스키마가 7만 토큰씩 실렸고,
개인 저장소 하나의 git 설정에는 GitHub 토큰이 평문으로 들어 있었다.

## 추적 1 — 같은 서버가 이름만 바꿔 두 번

`claude mcp list`를 보면 서버가 둘이었다.

```
claude-flow: npx -y ruflo@latest mcp start - ⏸ Pending approval
ruflo:       npx ruflo@latest mcp start    - ✔ Connected
```

실행하는 프로그램이 같다. `claude mcp remove claude-flow`는 "그런 서버 없음"으로 실패했다.
`claude mcp get`으로 찾아보니 이 서버는 프로젝트가 아니라 **홈 디렉터리의 `.mcp.json`** 에 있었다.
파일 생성 시각은 09:59:19였고, 5초 뒤에 홈 디렉터리의 `CLAUDE.md`가 생겼다.
오전에 홈 디렉터리에서 `init`이 한 번 돌았던 흔적이다. 오후에 프로젝트에서 다시 `init` 하면서 중복이 됐다.
홈의 `CLAUDE.md`는 그 아래 **모든** 프로젝트에 Ruflo 지침을 주입하고 있었다.

중복을 걷어내도 남는 비용이 있다. doctor 출력에 이런 줄이 있었다.

```
⚠ MCP Schema Overhead: 379 advertised tools ≈ 72750 schema tokens
```

도구 379개의 스키마가 세션마다 컨텍스트에 실린다. 중복을 그대로 뒀다면 두 배였다.

## 추적 2 — 무엇을 커밋할 것인가

`init`이 만든 파일은 팀과 공유할 설정과 이 PC에서만 의미 있는 상태가 섞여 있었다.
`memory-package.json`에는 로컬 npx 캐시의 절대경로가 들어 있었고,
metrics·mods·policy·security 디렉터리는 실행할 때마다 바뀌는 런타임 기록이었다.
이것들은 `.gitignore`로 뺐다. 에이전트 정의·커맨드·스킬·훅·`config.yaml`만 묶으니
238개 파일, 51,521줄이 됐고, 별도 브랜치에서 PR로 올렸다.
CI의 타입체크·린트는 통과했다. 앱 코드는 한 줄도 바뀌지 않았으니 당연한 결과다.

## 추적 3 — PR을 열려다 드러난 계정 문제

`gh pr create`가 `Could not resolve to a Repository`로 실패했다.
`gh`에는 개인 계정만, 맥 키체인에는 회사 계정만 로그인돼 있었다.
회사 계정을 `gh`에 추가하고 개인 저장소들을 점검하다가 두 가지가 더 나왔다.

| 저장소 | 발견한 것 |
|---|---|
| 소설 원고 | 작성자 이름은 개인 계정인데 이메일이 **회사 메일**. GitHub에는 회사 계정 커밋으로 집계된다 |
| 소설 원고 | push가 `Repository not found`. 키체인에 회사 계정 인증만 있었다 |
| 이 블로그 | remote URL 안에 `github_pat_…` 토큰이 **평문**으로 저장돼 있었다 |

토큰은 GitHub에서 "Never used" 상태였다. 주소에 적혀만 있고 push에는 한 번도 쓰이지 않은 채
`.git/config`에 남아 있었던 것이다. 바로 폐기했다.

## 해결 — 계정은 저장소가 고르게 한다

`gh auth setup-git`으로 git 인증을 `gh`에 맡기면 될 줄 알았다. 그런데 `gh`의 credential helper는
**활성 계정의 토큰만** 돌려준다. URL에 개인 계정 이름을 적어 둬도, 활성 계정이 회사 계정이면 응답이 비었다.
그렇다고 `gh auth switch`를 매번 하는 건 잊어버리라고 만든 함정이다.

그래서 개인 저장소에만 로컬 helper를 걸었다. 계정 이름을 고정해 두고, 토큰은 `gh`에서 그때그때 꺼낸다.

```bash
git config --local credential.https://github.com.helper ""   # 전역 helper 체인 초기화
git config --local --add credential.https://github.com.helper \
  '!f() { test "$1" = get && echo username=<개인계정> && echo "password=$(gh auth token -u <개인계정>)"; }; f'
git config --local user.email <개인계정>@users.noreply.github.com
```

| 구분 | 전 | 후 |
|---|---|---|
| MCP 서버 | 2개 (같은 프로그램 중복) | 1개 |
| 소설 저장소 push | 실패 (회사 계정 인증) | 성공 (개인 계정) |
| 소설 저장소 커밋 이메일 | 회사 메일 | 개인 noreply |
| 블로그 저장소 토큰 | `.git/config` 평문 | 폐기, `gh` 인증으로 대체 |
| 계정 전환 | `gh auth switch` 필요 | 저장소별 자동 |

## 배운 것

- **도구를 설치했으면 진단부터 끝까지 읽는다.** "All checks passed with some warnings"의 경고 줄에 7만 토큰짜리 비용이 적혀 있었다.
- **`init` 계열 명령은 어디서 실행했는지가 결과의 일부다.** 홈 디렉터리에서 한 번 돌린 흔적이 모든 프로젝트에 퍼져 있었다.
- **에이전트 설정 파일도 코드처럼 공유분과 로컬분을 가른다.** 절대경로와 런타임 상태가 섞인 채로 커밋하면 팀원 PC마다 diff가 생긴다.
- **비밀값은 '쓰이지 않는 곳'에 가장 오래 남는다.** 한 번도 안 쓰인 토큰이 아무도 모르게 설정 파일에 남아 있었다. 새 도구를 들이는 날은 주변 설정을 점검하기 좋은 날이다.
