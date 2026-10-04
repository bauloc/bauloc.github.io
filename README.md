# bauloc.github.io

[![pages-build-deployment](https://github.com/bauloc/bauloc.github.io/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/bauloc/bauloc.github.io/actions/workflows/pages/pages-build-deployment)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)

Website cá nhân của **Nguyen Phuoc Loc (BAULOC)**, Mobile Developer. Ngoài trang giới thiệu bản thân, site còn có một số công cụ nhỏ phục vụ việc phát triển và phát hành ứng dụng di động.

**Website:** https://bauloc.github.io

## Tính năng

| Trang | Mô tả |
| --- | --- |
| [Trang chủ](https://bauloc.github.io/) | Lối vào các mục của site, xem dạng List hoặc Grid, có giao diện sáng và tối. |
| [Profile](https://bauloc.github.io/profile/) | Giới thiệu, portfolio, quá trình làm việc, CV (PDF) và form liên hệ. |
| [XConsole](https://bauloc.github.io/xconsole/) | Công cụ quản trị: tạo trang Terms of Service và Privacy Policy để nộp ứng dụng lên App Store và Google Play, quản lý playlist IPTV. |
| [Device Lab](https://bauloc.github.io/device/) | Xem thông tin, chụp màn hình và đọc log của điện thoại kết nối với máy tính; với Android còn cài, gỡ và xuất ứng dụng. Có [bản demo](https://bauloc.github.io/device/?mock=1) dùng thiết bị mẫu. |

Mọi trang đều có giao diện sáng và tối (một lựa chọn chung cho cả site); các trang con có nút quay về trang chủ trên header. Trang chủ, Profile và XConsole có hai ngôn ngữ, Tiếng Việt và English: mặc định theo ngôn ngữ của trình duyệt, đổi bằng nút EN · VI và được nhớ lại. CV tải về cũng có hai bản.

### Device Lab

- **Android qua USB:** kết nối thẳng từ trình duyệt bằng WebUSB (Chrome hoặc Edge bản desktop), không cần cài thêm gì.
- **iPhone (macOS), iOS Simulator và Android qua Wi-Fi:** cần chạy helper trên máy, yêu cầu Node.js 18 trở lên:

  ```bash
  curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs
  node ~/device-bridge.mjs
  ```

  Thêm `--simulators` để hiện iOS Simulator. Helper chỉ lắng nghe trên `127.0.0.1:8787` và không gửi telemetry. Nhấn `Ctrl+C` để dừng.

## Công nghệ

- [React 19](https://react.dev), [TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev)
- [TanStack Router](https://tanstack.com/router) và [TanStack Query](https://tanstack.com/query)
- [Tailwind CSS 4](https://tailwindcss.com) và [shadcn/ui](https://ui.shadcn.com)
- [Vitest](https://vitest.dev), ESLint, Prettier
- [ya-webadb](https://github.com/yume-chan/ya-webadb) cho kết nối Android qua WebUSB
- GitHub Pages để host

## Bắt đầu

### Yêu cầu

- Node.js `^20.19.0`, `^22.13.0` hoặc `>=24`
- npm

### Cài đặt

```bash
git clone https://github.com/bauloc/bauloc.github.io.git
cd bauloc.github.io/_app
npm ci
npm run dev
```

Mở http://localhost:7360. Mọi lệnh npm đều chạy trong thư mục `_app/`.

### Lệnh thường dùng

| Lệnh | Mô tả |
| --- | --- |
| `npm run dev` | Chạy dev server tại http://localhost:7360 |
| `npm test` | Chạy test bằng Vitest |
| `npm run lint` | Kiểm tra code bằng ESLint |
| `npm run typecheck` | Kiểm tra kiểu TypeScript |
| `npm run build` | Build vào `_app/dist` |
| `npm run verify` | Chạy typecheck, lint, test (cả site và helper) rồi build |
| `npm run publish` | Chép bản build ra thư mục gốc của repo |
| `npm run deploy` | Chạy `verify` rồi `publish` |

### Biến môi trường

Form liên hệ gửi tin nhắn qua bot Telegram. `VITE_TELEGRAM_BOT_TOKEN` và `VITE_TELEGRAM_CHAT_ID` nằm trong [`_app/.env.production`](_app/.env.production). File này được commit vào repo nên bản build nào cũng có, kể cả khi build trong git worktree. `npm run dev` không đọc file này: nếu `_app/.env` không có hai biến đó, form ở máy dev sẽ mở ứng dụng email của người gửi.

> Giá trị các biến `VITE_*` được nhúng vào JavaScript công khai của site, ai cũng đọc được.

## Cấu trúc thư mục

```text
.
├── _app/               # Mã nguồn (Vite + React + TypeScript), không được publish
│   ├── src/features/   # home, profile, xconsole, device
│   ├── src/routes/     # Route theo file (TanStack Router)
│   ├── helper/         # Mã nguồn helper của Device Lab
│   └── scripts/        # publish, check-live, cv, ...
├── assets/             # JS, CSS, ảnh đã build
├── index.html          # Trang chủ (bản build)
├── 404.html            # Bản sao của index.html để mở được deep link
├── profile/            # Trang HTML của từng mục (bản build)
├── xconsole/
├── device/
│   └── agent/          # Helper của Device Lab (device-bridge.mjs)
├── terms/              # Trang Terms of Service do XConsole tạo
├── privacy/            # Trang Privacy Policy do XConsole tạo
└── data/, iptv         # Dữ liệu do XConsole quản lý
```

## Triển khai

GitHub Pages phục vụ site trực tiếp từ thư mục gốc của branch `master`, vì vậy bản build được commit cùng mã nguồn:

1. Tạo branch mới từ `master` và sửa code trong `_app/`.
2. Chạy `npm run deploy` để kiểm tra và chép bản build ra thư mục gốc.
3. Commit cả mã nguồn lẫn bản build, rồi mở pull request vào `master`.
4. Sau khi merge, GitHub Pages tự build lại và site được cập nhật sau khoảng một phút.

> **Lưu ý:** `terms/`, `privacy/`, `data/` và `iptv` do XConsole ghi trực tiếp lên `master`; `npm run publish` không bao giờ ghi đè các đường dẫn này. Không sửa tay hay đổi URL các trang pháp lý, vì chúng đã được khai báo trên App Store và Google Play.

## Liên hệ

- Profile: https://bauloc.github.io/profile/ (mục **Contact** có form liên hệ)
- GitHub: [@bauloc](https://github.com/bauloc)

## Giấy phép

Repo hiện chưa kèm giấy phép mã nguồn mở. Font và thư viện bên thứ ba giữ giấy phép riêng của chúng.
