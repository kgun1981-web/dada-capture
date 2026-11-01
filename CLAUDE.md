# CLAUDE.md

## 이 프로젝트는
**다다 기록 (dada-capture)**: 아이폰 Safari에서 홈 화면에 추가해 쓰는 오프라인 현장 기록 앱(PWA)입니다. 기록(날짜·장소·주제)에 사진과 메모를 모으고, ZIP 묶음(사진 + `notes.txt` + `기록.md` + `manifest.json`)으로 만들어 iOS 공유 시트로 내보냅니다.

- 단순한 정적 사이트입니다.
  - `index.html`: 화면 구성과 CSS 전부
  - `app.js`: 동작 코드 전부
  - `sw.js`: 오프라인 실행용 캐시
  - 그 밖에 `manifest.webmanifest`, 아이콘, `.nojekyll`
- 정적 파일로 배포됩니다(GitHub Pages로 보임).
- **빌드 과정, package.json, 외부 라이브러리, 프레임워크가 없습니다.** 앞으로도 그대로 둡니다. npm 패키지, 번들러, CDN, 외부 요청을 추가하지 않습니다.
- 자료는 기기 안에만 있습니다.
  - IndexedDB `dada-capture` 버전 1
    - 저장소: `records`, `photos`, `blobs`
    - `photos`의 색인: `byRecord`, `bySha`
  - `localStorage` 키
    - `dada.open`
    - `dada.draft.<기록id>`

## 확인 명령
```bash
# 문법 확인 (테스트 모음은 없음)
node --check app.js && node --check sw.js && python3 -m json.tool manifest.webmanifest >/dev/null

# 로컬에서 실행
python3 -m http.server 8000   # → http://localhost:8000/index.html
```
화면 확인은 미리 설치된 Playwright로 합니다.

1. 페이지를 엽니다.
2. `window.__dadaReady === true`가 될 때까지 기다립니다. `init()`이 끝나면 이 값이 설정됩니다.
3. `#appVersion`에 새 버전이 보이는지 확인합니다.
4. `pageerror`나 콘솔 오류가 없는지 확인합니다.

확인용 스크립트는 저장소가 아니라 임시 폴더(scratchpad)에 둡니다.

## 새 버전 낼 때 규칙 (사용자에게 보이는 변경마다)
1. `app.js`의 `APP_VERSION`을 올립니다.
   - 수정: `0.5.4` → `0.5.5`
   - 새 기능: `0.6`
2. `sw.js`의 `VERSION`(`dada-capture-shell-vNN`)을 1 올립니다. **빠뜨리면 이미 설치된 휴대폰에 예전 화면이 계속 남습니다.**
3. 화면 파일을 새로 추가하면 `sw.js`의 `SHELL` 목록에도 넣습니다.
4. 아래 두 번호는 PC 쪽 도구가 사용하므로 꼭 필요할 때만 바꿉니다. 내보내기 항목 이름도 바꾸지 않습니다.
   - `HASH_VERSION`: `exportRecord()`의 `content_hash` 계산 내용이 바뀔 때만
   - `SCHEMA_VERSION`: 기록이나 manifest 구조가 바뀔 때만
5. IndexedDB 구조를 바꿀 때는 버전을 올리고 `onupgradeneeded`에서 기존 자료를 옮깁니다. 사용자 자료를 절대 버리지 않습니다.

커밋 메시지 형식: `vX.Y.Z: 바뀐 내용을 쉼표로 이어 쓴 한국어 요약` (`git log` 참고)

## 코드 작성 방식
- `'use strict'`와 순수 JavaScript(ES2020 이상)를 씁니다. 모듈은 쓰지 않습니다.
- 공용 도구
  - `$ = id => document.getElementById(id)`
  - `tx`, `getOne`, `getAll`, `putRecord`
- 기록은 반드시 `mutate(id, fn)`으로 고칩니다.
  - 한 트랜잭션 안에서 읽고 고치고 저장하므로, 백그라운드 저장이나 내보내기가 다른 기록을 덮어쓰지 않습니다.
  - `await` 뒤에 화면을 건드리기 전에는 `current.id`를 다시 확인합니다.
- 들여쓰기는 2칸, 작은따옴표, 세미콜론을 씁니다. 짧은 도우미는 한 줄로 써도 됩니다. 주변 코드의 밀도에 맞춥니다.
- `localStorage` 호출은 모두 `try/catch`로 감싸고 `/* 무시 */`로 처리합니다.
- 화면 요소는 `textContent`와 `createElement`로 만듭니다. 사용자가 입력한 글을 `innerHTML`에 넣지 않습니다.
- **화면 글자, 코드 주석, 커밋 메시지는 모두 한국어로 씁니다.** 개발자가 아닌 사용자도 알기 쉬운 친절한 말투로 씁니다.
- 오류 메시지에는 원본이 안전하다는 점을 함께 알립니다(예: "앱 안 원본은 지우지 않았습니다").
- CSS는 `index.html` 안에 두고 `:root` 색 변수(`--brand`, `--accent`, `--warn` 등)를 씁니다.

## 꼭 지킬 것
- **개인정보 보호가 핵심 기능입니다.**
  - 네트워크 전송, 분석 도구, 업로드 코드를 넣지 않습니다.
  - 공유는 사용자가 공유 시트(`navigator.share`)에서 직접 고를 때만 일어납니다.
  - ChatGPT를 고르면 파일이 올라간다는 안내를 유지합니다.
- 대상은 홈 화면에 추가한 iOS Safari입니다. 다음을 주의합니다.
  - HEIC·MOV 파일
  - 날짜 칸 모양
  - 저장 용량(`storageCheck`/`hasRoomFor`)
  - 공유 시트는 사용자가 누를 때만 열리므로 파일을 미리 준비해 둠
- 실제 기기에서 확인한 저장 방법은 **공유 → 파일에 저장 → iCloud Drive › DadaRecords**입니다. 다운로드는 보조 수단입니다.
- 내보낼 때 사진의 크기와 SHA-256 확인값을 검사합니다. 원본을 몰래 바꾸지 않습니다.
- 새 버전이 나와도 앱이 스스로 다시 시작하지 않습니다. `#updateBar` 안내를 띄우고, 사용자가 저장을 마친 뒤 직접 누르게 합니다.
