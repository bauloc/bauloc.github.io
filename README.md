# bauloc.github.io

[![pages-build-deployment](https://github.com/bauloc/bauloc.github.io/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/bauloc/bauloc.github.io/actions/workflows/pages/pages-build-deployment)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)

Website cá nhân của **Nguyễn Phước Lộc (BAULOC)**, lập trình viên phần mềm và kỹ sư Điện – Điện tử. Ngoài trang giới thiệu bản thân, site còn có một số công cụ nhỏ phục vụ việc phát triển và phát hành ứng dụng di động.

**Website:** https://bauloc.github.io

## Tính năng

| Trang | Mô tả |
| --- | --- |
| [Trang chủ](https://bauloc.github.io/) | Lối vào các mục của site, xem dạng List hoặc Grid, có giao diện sáng và tối. |
| [Profile](https://bauloc.github.io/profile/) | Giới thiệu, portfolio, quá trình làm việc, CV (PDF) và form liên hệ. |
| [XConsole](https://bauloc.github.io/xconsole/) | Công cụ quản trị: tạo trang Terms of Service và Privacy Policy để nộp ứng dụng lên App Store và Google Play, gửi bản build APK/IPA cho tester qua link cài đặt, đăng trang HTML (artifact), quản lý playlist IPTV. |
| [Device Lab](https://bauloc.github.io/device/) | Xem thông tin, chụp màn hình và đọc log của điện thoại kết nối với máy tính; với Android còn cài, gỡ và xuất ứng dụng. Có [bản demo](https://bauloc.github.io/device/?mock=1) dùng thiết bị mẫu. |

Mọi trang đều có giao diện sáng và tối (một lựa chọn chung cho cả site). Mọi trang, kể cả trang chủ, dùng chung một header: các mục của site (Trang chủ, Hồ sơ, XConsole, Device Lab), nút EN · VI và nút sáng/tối. Trang chủ, Profile, XConsole và Device Lab có hai ngôn ngữ, Tiếng Việt và English: mặc định theo ngôn ngữ của trình duyệt, đổi bằng nút EN · VI và được nhớ lại. CV tải về cũng có hai bản.

### Device Lab

- **Android qua USB:** kết nối thẳng từ trình duyệt bằng WebUSB (Chrome hoặc Edge bản desktop), không cần cài thêm gì.
- **iPhone (macOS), iOS Simulator và Android qua Wi-Fi:** cần chạy helper trên máy, yêu cầu Node.js 18 trở lên:

  ```bash
  curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs
  node ~/device-bridge.mjs
  ```

  Thêm `--simulators` để hiện iOS Simulator. Helper chỉ lắng nghe trên `127.0.0.1:8787` và không gửi telemetry. Nhấn `Ctrl+C` để dừng.

  Qua helper, thiết bị Android (cả TV và điện thoại qua Wi-Fi) dùng được mọi tính năng như khi cắm cáp: cài, gỡ, xuất ứng dụng và xem ảnh.

### XConsole: Builds và Artifacts

- **Builds:** tải lên file `.apk` hoặc `.ipa`. XConsole đọc thông tin bản build (tên, phiên bản, icon, provisioning profile) và đăng một trang cài đặt tại `https://bauloc.github.io/build/<id>/` để gửi cho tester. Trên Android, nút Install tải file APK về; trên iPhone và iPad, nút Install cài qua `itms-services` (mở bằng Safari, IPA phải ký Ad Hoc, Development hoặc Enterprise). Trên máy tính, trang hiện mã QR để quét bằng điện thoại.
- **Artifacts:** tải lên hoặc dán một file HTML, XConsole đăng tại `https://bauloc.github.io/artifact/<id>.html`. Mặc định trang chạy trong iframe sandbox khác origin, nên không đọc được token GitHub mà XConsole lưu trong trình duyệt.
- File được commit thẳng vào repo này qua GitHub API: mỗi file phải nhỏ hơn 100 MB (giới hạn của GitHub), và bản đã tải lên vẫn nằm trong lịch sử git kể cả khi đã xoá. Site GitHub Pages tối đa khoảng 1 GB, nên hãy xoá các bản build cũ.
- Bản build từ 100 MB trở lên (tối đa dưới 2 GB) được đưa lên GitHub Releases thay vì vào repo, qua helper của Device Lab chạy trên máy Mac (trình duyệt không tự tải file lên GitHub Releases được): `curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs`. Link cài đặt vẫn như cũ; xoá bản build thì release của nó cũng bị xoá.

## Repo này

Repo này chứa đúng những gì GitHub Pages phục vụ, từ thư mục gốc của branch `master`. Mã nguồn của site (React, TypeScript, Vite) nằm ở một repo riêng tư; mỗi thay đổi được merge ở đó, CI build lại và đẩy bản build sang đây.

| Đường dẫn | Ai ghi |
| --- | --- |
| `index.html`, `404.html`, `assets/`, `profile/index.html`, `xconsole/index.html`, `device/index.html`, `device/agent/device-bridge.mjs` | CI của repo mã nguồn, mỗi lần deploy |
| `terms/`, `privacy/`, `build/`, `artifact/`, `data/`, `iptv` | XConsole, qua GitHub API |
| `README.md`, `_config.yml`, `profile/flutter_service_worker.js` | Viết tay |

> **Lưu ý:** đừng sửa tay các file build, lần deploy sau sẽ ghi đè. Không sửa tay hay đổi URL các trang pháp lý trong `terms/` và `privacy/`, vì chúng đã được khai báo trên App Store và Google Play.

## Công nghệ

- [React 19](https://react.dev), [TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev)
- [TanStack Router](https://tanstack.com/router) và [TanStack Query](https://tanstack.com/query)
- [Tailwind CSS 4](https://tailwindcss.com) và [shadcn/ui](https://ui.shadcn.com)
- [ya-webadb](https://github.com/yume-chan/ya-webadb) cho kết nối Android qua WebUSB và qua helper
- GitHub Pages để host

## Liên hệ

- Profile: https://bauloc.github.io/profile/ (mục **Contact** có form liên hệ)
- GitHub: [@bauloc](https://github.com/bauloc)

## Giấy phép

Repo hiện chưa kèm giấy phép mã nguồn mở. Font và thư viện bên thứ ba giữ giấy phép riêng của chúng.
