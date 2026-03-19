# Kế hoạch: XConsole - Bộ công cụ cá nhân trên GitHub Pages

## Bối cảnh

Xây dựng một web tool tĩnh (static site) host trên GitHub Pages (`bauloc.github.io`) với nhiều tính năng khác nhau, truy cập qua một console chung.

**URL sử dụng**: `https://bauloc.github.io/xconsole`

**Giai đoạn 1 này**: Xây dựng tính năng đầu tiên — **Term & Privacy** — để tạo và quản lý các trang Terms of Service + Privacy Policy cho việc đăng ký ứng dụng lên Apple App Store / Google Play Store. Các tính năng khác sẽ được thêm vào sau.

**Lý do**: App store yêu cầu một URL công khai có thể truy cập cho Terms/Privacy. Tool này tự động sinh ra các trang HTML sạch, đúng chuẩn mà không cần backend server.

---

## Kiến trúc

Toàn bộ là static site trên GitHub Pages, không có backend. Console dùng **GitHub REST API** với Personal Access Token (PAT) lưu trong `localStorage` của trình duyệt để commit file JSON + file HTML được sinh ra trực tiếp vào repo.

**Đọc dữ liệu**: `raw.githubusercontent.com` (không cần auth, không bị CORS)
**Ghi dữ liệu**: `api.github.com/repos/bauloc/bauloc.github.io/contents/...` (cần PAT)

---

## Cấu trúc thư mục (trong repo `bauloc.github.io`)

```
bauloc.github.io/
├── xconsole/
│   ├── index.html          # Shell chính: sidebar điều hướng + khu vực nội dung
│   ├── style.css           # CSS toàn bộ console
│   ├── app.js              # Core: router, GitHub API helpers, PAT setup
│   └── modules/
│       └── term-privacy/
│           ├── index.js    # Logic tính năng Term & Privacy
│           └── data/
│               ├── db.json # Index tổng (commit sẵn lúc khởi tạo)
│               └── pages/
│                   └── {slug}.json # Dữ liệu từng app (do tool tạo)
├── terms/
│   └── {slug}/
│       └── index.html      # Trang Terms of Service (do tool tạo ra)
└── privacy/
    └── {slug}/
        └── index.html      # Trang Privacy Policy (do tool tạo ra)
```

### Thiết kế layout console

```
┌──────────────┬───────────────────────────────────────┐
│  XConsole    │                                       │
│  ──────────  │    [Nội dung của mục đang chọn]       │
│  ▶ Term &    │                                       │
│    Privacy   │                                       │
│              │                                       │
│  + Tính năng │                                       │
│    khác...   │                                       │
│              │                                       │
│  ──────────  │                                       │
│  ⚙ Settings  │                                       │
└──────────────┴───────────────────────────────────────┘
```

Sidebar bên trái chứa danh sách các module/tính năng. Phần nội dung bên phải thay đổi theo module đang chọn. Các module tương lai chỉ cần thêm vào sidebar và tạo file JS tương ứng trong `modules/`.

---

## Schema dữ liệu

### `xconsole/modules/term-privacy/data/db.json` (index tổng)
```json
{
  "version": 1,
  "updated_at": "ISO8601",
  "entries": [
    {
      "slug": "my-cool-app",
      "app_name": "My Cool App",
      "created_at": "ISO8601",
      "updated_at": "ISO8601",
      "terms_url": "https://bauloc.github.io/terms/my-cool-app/",
      "privacy_url": "https://bauloc.github.io/privacy/my-cool-app/",
      "platform": ["ios", "android"]
    }
  ]
}
```

### `xconsole/modules/term-privacy/data/pages/{slug}.json` (dữ liệu từng trang)
```json
{
  "slug": "my-cool-app",
  "app_name": "My Cool App",
  "developer_name": "...",
  "developer_email": "...",
  "website_url": "...",
  "platform": ["ios", "android"],
  "app_description": "...",
  "effective_date": "YYYY-MM-DD",
  "last_updated": "YYYY-MM-DD",
  "data_collected": ["email", "usage_data"],
  "data_used_for": "...",
  "third_party_services": ["Firebase"],
  "has_account_creation": false,
  "children_under_13": false,
  "contact_email": "...",
  "country": "Vietnam"
}
```

---

## Các trường dữ liệu trong form Tạo/Sửa

**Thông tin App**: app_name, slug (tự sinh, có thể sửa), platform (iOS/Android/Cả hai), app_description
**Thông tin Developer**: developer_name, developer_email, website_url, country
**Ngày hiệu lực**: effective_date
**Dữ liệu & Bảo mật**: data_collected (checkbox: name/email/location/device_info/usage_data/camera/contacts/payment), data_used_for, third_party_services, has_account_creation, children_under_13
**Liên hệ**: contact_email

Slug tự sinh: `app_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')`

---

## Các bước thực hiện

### Bước 0 - Chuẩn bị
1. Tạo tất cả file trong thư mục làm việc hiện tại (`/Volumes/PROJECT/BAULOC/TOOL/bauloc-utils`)
2. Khởi tạo git repo: `git init`, thêm remote `https://github.com/bauloc/bauloc.github.io.git`
3. Tạo cấu trúc thư mục: `xconsole/modules/term-privacy/data/pages/`, `terms/`, `privacy/`

### Bước 1 - Bootstrap file dữ liệu ban đầu
Tạo `xconsole/modules/term-privacy/data/db.json` với entries rỗng và commit ngay. Cần thiết vì GitHub API cần SHA của file khi ghi đè.

```json
{"version":1,"updated_at":"2026-03-19T00:00:00Z","entries":[]}
```

### Bước 2 - `xconsole/index.html` (shell chính)
- HTML skeleton: sidebar trái cố định + khu vực `#module-content` bên phải
- Sidebar: logo "XConsole", danh sách module nav (Term & Privacy là mục đầu, placeholder cho các mục sau), nút Settings ở dưới cùng
- Modal nhập PAT (ẩn, hiển thị khi không có token trong localStorage)
- Modal Settings để cập nhật PAT
- Load `app.js` và `modules/term-privacy/index.js`

### Bước 3 - `xconsole/style.css`
- CSS custom properties: `--primary: #1a1a2e`, `--accent: #0066cc`, `--sidebar-bg`, `--content-bg`
- Layout: sidebar cố định bên trái + content area flex-grow
- Sidebar: nav items với trạng thái active/hover, responsive (thu thành icon trên mobile)
- Card, form panel trượt từ phải, modal overlay, toast — dùng chung cho tất cả module
- Các kiểu nút: primary, secondary, danger

### Bước 4 - `xconsole/app.js` (core)
- Quản lý PAT: kiểm tra localStorage, hiện modal setup nếu chưa có
- GitHub API helpers:
  - `githubReadFile(path)` → `{ sha, content }` hoặc null
  - `githubWriteFile(path, content, message)` → ghi/cập nhật file
  - Encode UTF-8: `btoa(unescape(encodeURIComponent(str)))`
- Client-side router đơn giản: dựa vào `location.hash` để active module
- `showToast(msg, type)` — dùng chung cho tất cả module

### Bước 5 - `xconsole/modules/term-privacy/index.js`
- `init()` → fetch `db.json` từ `raw.githubusercontent.com` → `renderList()`
- `renderList(entries)` → sinh card với 2 URL (Terms + Privacy) + nút Copy riêng + nút Edit
- Form Tạo/Sửa (trượt từ phải) với tất cả các trường (xem phần Form Fields)
- `handleFormSubmit()`:
  ```
  1. Validate → sinh slug → kiểm tra trùng (githubReadFile)
  2. Ghi xconsole/modules/term-privacy/data/pages/{slug}.json
  3. Cập nhật db.json (đọc SHA → prepend entry → ghi lại)
  4. Sinh HTML Terms → ghi terms/{slug}/index.html   ┐ song
  5. Sinh HTML Privacy → ghi privacy/{slug}/index.html ┘ song
  6. Toast thành công với 2 URL + "~1 phút để live"
  7. Đóng form, reload danh sách
  ```
- `generateTermsHTML(data)` và `generatePrivacyHTML(data)`: điền `{{PLACEHOLDER}}` vào template
- `TERMS_TEMPLATE` và `PRIVACY_TEMPLATE`: template literal, HTML/CSS tự chứa, inline style
- Mỗi trang có link sang trang kia

**Xử lý lỗi**:
- 401 → "Invalid token - update in Settings"
- 409 (SHA conflict) → lấy lại SHA và retry một lần
- Lỗi khác → toast lỗi, giữ nguyên form

### Bước 6 - Commit & Deploy _(làm sau, khi UI đã ổn)_
Commit tất cả file vào repo `bauloc.github.io` và push. GitHub Pages deploy trong ~1 phút.

> **Ưu tiên hiện tại**: Build và test UI local trước. Commit GitHub sau khi UI hoàn thiện.

---

## Nội dung 2 trang HTML (đúng chuẩn Apple/Google)

**Trang Terms of Service** (`terms/{slug}/`):
- Acceptance of Terms, Use of App, Intellectual Property, Limitation of Liability, Changes to Terms
- Có link → trang Privacy Policy

**Trang Privacy Policy** (`privacy/{slug}/`):
- Information We Collect, How We Use It, Third-Party Services, Children's Privacy (COPPA nếu children_under_13=true), Contact Us
- Có link → trang Terms of Service

Mỗi card trong console hiển thị **2 URL riêng** với nút Copy riêng:
```
[Terms URL]   bauloc.github.io/terms/my-app/   [Copy]
[Privacy URL] bauloc.github.io/privacy/my-app/ [Copy]
```

---

## Kiểm tra

1. Mở `xconsole/index.html` trực tiếp trong trình duyệt (file://) để test UI
2. Nhập PAT (cần scope `repo` hoặc `contents: write` với fine-grained token)
3. Xác nhận trạng thái danh sách rỗng hiển thị đúng
4. Tạo trang term mới → điền đủ các trường → Save & Publish
5. Xác nhận **4 file** xuất hiện trong GitHub repo: `data/pages/{slug}.json`, `db.json` (đã cập nhật), `terms/{slug}/index.html`, `privacy/{slug}/index.html`
6. Sau ~1 phút: mở cả 2 URL và xác nhận trang hiển thị đúng, có link qua lại giữa 2 trang
7. Test nút Copy URL, chức năng Edit trang đã có, modal Settings

---

## Lưu ý quan trọng

- **CORS**: Cả `api.github.com` và `raw.githubusercontent.com` đều có CORS header đúng — không cần proxy
- **Base64 UTF-8**: Luôn dùng `btoa(unescape(encodeURIComponent(str)))` để xử lý đúng ký tự tiếng Việt
- **Jekyll**: `_config.yml` hiện tại dùng theme Cayman — các file `.html` không có Jekyll front matter sẽ được serve nguyên vẹn, không cần thay đổi
- **Rate limit**: 5000 req/giờ khi có xác thực — tối đa 6 API call mỗi lần tạo trang, không đáng lo ngại
- **Độ trễ deploy**: 30-60 giây sau khi commit mới GitHub Pages serve được file mới
