import { defineMessages } from '@/lib/i18n'

/*
  The Artifacts module's words. The module's title and description are XConsole's (messages.tsx,
  `module.artifacts`), and the checks word their own problems (model.ts). The served wrapper is
  not worded here: its few words are in both languages in the file itself.
*/

export const ARTIFACT_MESSAGES = defineMessages({
  en: {
    upload: 'Upload HTML',
    loadFailed: 'Could not load the artifacts',
    indexMissing: 'The artifact index was not found',
    indexMissingDetail: (path: string) =>
      `There is no ${path} on the master branch, but artifact/ still serves pages. Publishing stays off until the index is back, so the real list cannot be overwritten.`,
    retry: 'Retry',

    count: 'Artifacts',
    totalSize: (size: string) => `${size} in total`,
    sandboxed: 'Sandboxed',
    allIsolated: 'Every page is kept apart from this console',
    fullPages: (count: number) =>
      count === 1 ? '1 runs as a full page' : `${String(count)} run as full pages`,
    lastPublished: 'Last published',
    goLive: 'Pages go live about a minute after publishing',

    empty: 'No artifacts yet',
    emptyDetail:
      'Upload an HTML file and it is served at bauloc.github.io/artifact/…, in a sandbox that keeps it away from this console.',
    uploadFirst: 'Upload the first page',

    deleting: (title: string) => `Deleting ${title}…`,
    indexMissingNothingDeleted: (path: string) =>
      `${path} is missing on GitHub — nothing was deleted.`,
    alreadyDeleted: 'Already deleted',
    alreadyDeletedDetail: (title: string) => `${title} was deleted elsewhere.`,
    deleted: 'Deleted',
    deletedDetail: (title: string) => `${title} is no longer served.`,
    deleteFailed: 'Delete failed',
    deleteTitle: (title: string) => `Delete ${title}?`,
    deleteDetail:
      'This removes the page and its link from GitHub. Anyone who opens the link will get a 404.',
    delete: 'Delete',

    badgeSandboxed: 'Sandboxed',
    badgeFull: 'Full page',
    sandboxedTitle: 'Runs in a sandbox, apart from this console',
    fullTitle: 'Runs with full access to bauloc.github.io',
    pasted: 'Pasted HTML',
    copyUrl: 'Copy the link',
    open: 'Open',
    actionsFor: (title: string) => `Actions for ${title}`,
    edit: 'Edit',
    download: 'Download HTML',
    downloading: 'Preparing the download…',
    downloadFailed: 'Download failed',

    servedMissing: (path: string) => `${path} is missing on GitHub.`,
    servedUnreadable: (path: string) =>
      `${path} does not hold the page in the form XConsole writes it.`,

    newTitle: 'Upload an HTML page',
    newDescription: 'One file, served at a link of its own.',
    editTitle: 'Edit artifact',
    editDescription: (id: string) => `Changes publish over ${id}.`,
    openFailed: 'Could not open the page',

    page: 'Page',
    fromFile: 'File',
    paste: 'Paste HTML',
    dropLabel: 'Drop an HTML file here, or click to choose one',
    dropHint: (max: string) => `.html or .htm, up to ${max}`,
    notHtml: 'Choose an .html or .htm file.',
    notUtf8:
      'This file is not saved as UTF-8, so its text would come out garbled. Save it as UTF-8 in your editor, then choose it again.',
    readFailed: 'Could not read the file',
    removeFile: 'Remove the file',
    current: (name: string, size: string) => `Published now: ${name} · ${size}.`,
    replaceHint: 'Choose a file only to replace it.',
    pasteLabel: 'HTML to publish',
    pasteKeep: 'Leave this empty to keep the published page.',
    large: (size: string) =>
      `${size} is a large page: every version of it stays in the repository's history for good.`,

    details: 'Details',
    title: 'Title',
    titlePlaceholder: 'e.g. Quarterly report',
    titleHint: "Taken from the page's <title>, or else the file name; change it freely.",
    link: 'Link',
    regenerate: 'Make a new random link',
    linkFixed: 'The link is the published address, so it cannot change.',

    security: 'Security',
    sandbox: 'Run in a sandbox (recommended)',
    sandboxHint:
      'The page runs in a frame of its own and cannot see this console or its token. What it saves in localStorage is kept for it alone.',
    fullWarning:
      'Without the sandbox the page runs with full access to bauloc.github.io — including the XConsole token saved in this browser. Turn it off only for HTML you wrote or trust.',

    preview: 'Preview',
    previewEmpty: 'Choose a file or paste HTML to see it here.',
    previewFrame: (title: string) => `Preview of ${title}`,
    untitled: 'Untitled page',
    openPreview: 'Open preview in new tab',
    previewSandboxed: 'The preview always runs in the sandbox.',

    uploading: (sent: string, total: string) => `Uploading ${sent} of ${total}`,
    uploadProgress: 'Upload progress',
    cancelUpload: 'Cancel upload',
    uploadCancelled: 'Upload cancelled',
    servedTooLarge: (size: string, max: string) =>
      `Wrapped for the sandbox the page is ${size}, over GitHub's ${max} limit for one file. Make it smaller.`,
    publishing: 'Publishing…',
    updating: 'Updating…',
    indexMissingNothingPublished: (path: string) =>
      `${path} is missing on GitHub — nothing was published.`,
    idTaken: (id: string) => `The link "${id}" is already in use. Choose another.`,
    published: 'Published',
    updated: 'Updated',
    liveSoon: 'Live in about a minute:',
    publishFailed: 'Publish failed',
    tokenRefused: 'GitHub refused the token. Update it, then publish again — this page is kept.',
    publish: 'Publish',
    savePublish: 'Save & publish',
  },
  vi: {
    upload: 'Tải lên HTML',
    loadFailed: 'Không tải được danh sách artifact',
    indexMissing: 'Không tìm thấy chỉ mục artifact',
    indexMissingDetail: (path: string) =>
      `Nhánh master không có ${path}, nhưng artifact/ vẫn đang phục vụ trang. Chức năng đăng tạm khóa cho đến khi chỉ mục trở lại, để danh sách thật không bị ghi đè.`,
    retry: 'Thử lại',

    count: 'Artifact',
    totalSize: (size: string) => `Tổng ${size}`,
    sandboxed: 'Chạy trong sandbox',
    allIsolated: 'Mọi trang đều tách biệt khỏi console này',
    fullPages: (count: number) => `${String(count)} trang chạy toàn quyền`,
    lastPublished: 'Lần đăng gần nhất',
    goLive: 'Trang lên sóng khoảng một phút sau khi đăng',

    empty: 'Chưa có artifact nào',
    emptyDetail:
      'Tải lên một file HTML để đăng tại bauloc.github.io/artifact/…, chạy trong sandbox tách biệt khỏi console này.',
    uploadFirst: 'Tải lên trang đầu tiên',

    deleting: (title: string) => `Đang xóa ${title}…`,
    indexMissingNothingDeleted: (path: string) =>
      `Không thấy ${path} trên GitHub — chưa xóa gì cả.`,
    alreadyDeleted: 'Đã bị xóa từ trước',
    alreadyDeletedDetail: (title: string) => `${title} đã bị xóa ở nơi khác.`,
    deleted: 'Đã xóa',
    deletedDetail: (title: string) => `${title} không còn được đăng nữa.`,
    deleteFailed: 'Xóa thất bại',
    deleteTitle: (title: string) => `Xóa ${title}?`,
    deleteDetail: 'Thao tác này xóa trang và link của nó khỏi GitHub. Ai mở link sẽ gặp lỗi 404.',
    delete: 'Xóa',

    badgeSandboxed: 'Sandbox',
    badgeFull: 'Toàn quyền',
    sandboxedTitle: 'Chạy trong sandbox, tách biệt khỏi console này',
    fullTitle: 'Chạy với toàn quyền trên bauloc.github.io',
    pasted: 'HTML dán vào',
    copyUrl: 'Sao chép link',
    open: 'Mở',
    actionsFor: (title: string) => `Thao tác với ${title}`,
    edit: 'Sửa',
    download: 'Tải HTML về',
    downloading: 'Đang chuẩn bị tải về…',
    downloadFailed: 'Tải về thất bại',

    servedMissing: (path: string) => `Không thấy ${path} trên GitHub.`,
    servedUnreadable: (path: string) => `${path} không chứa trang theo dạng XConsole ghi.`,

    newTitle: 'Tải lên trang HTML',
    newDescription: 'Một file, đăng tại link riêng.',
    editTitle: 'Sửa artifact',
    editDescription: (id: string) => `Thay đổi sẽ được đăng đè lên ${id}.`,
    openFailed: 'Không mở được trang',

    page: 'Trang',
    fromFile: 'File',
    paste: 'Dán HTML',
    dropLabel: 'Thả file HTML vào đây hoặc bấm để chọn',
    dropHint: (max: string) => `.html hoặc .htm, tối đa ${max}`,
    notHtml: 'Hãy chọn file .html hoặc .htm.',
    notUtf8:
      'File này không được lưu ở dạng UTF-8 nên chữ sẽ bị lỗi. Hãy lưu lại file ở dạng UTF-8 trong trình soạn thảo rồi chọn lại.',
    readFailed: 'Không đọc được file',
    removeFile: 'Bỏ file',
    current: (name: string, size: string) => `Đang đăng: ${name} · ${size}.`,
    replaceHint: 'Chỉ chọn file khi muốn thay trang này.',
    pasteLabel: 'HTML cần đăng',
    pasteKeep: 'Để trống để giữ trang đang đăng.',
    large: (size: string) =>
      `${size} là trang khá lớn: mọi phiên bản của nó đều nằm lại vĩnh viễn trong lịch sử repo.`,

    details: 'Thông tin',
    title: 'Tiêu đề',
    titlePlaceholder: 'vd: Báo cáo quý',
    titleHint: 'Lấy từ thẻ <title> của trang, nếu không có thì từ tên file; có thể sửa tùy ý.',
    link: 'Link',
    regenerate: 'Tạo link ngẫu nhiên khác',
    linkFixed: 'Link là địa chỉ đã đăng nên không thể đổi.',

    security: 'Bảo mật',
    sandbox: 'Chạy trong sandbox (khuyên dùng)',
    sandboxHint:
      'Trang chạy trong một khung riêng, không thấy được console này hay token của nó. Dữ liệu trang lưu vào localStorage được giữ riêng cho trang.',
    fullWarning:
      'Không có sandbox, trang chạy với toàn quyền trên bauloc.github.io — kể cả token XConsole đang lưu trong trình duyệt này. Chỉ tắt với HTML do bạn viết hoặc bạn tin tưởng.',

    preview: 'Xem trước',
    previewEmpty: 'Chọn file hoặc dán HTML để xem trước tại đây.',
    previewFrame: (title: string) => `Xem trước ${title}`,
    untitled: 'Trang chưa đặt tên',
    openPreview: 'Mở bản xem trước trong tab mới',
    previewSandboxed: 'Bản xem trước luôn chạy trong sandbox.',

    uploading: (sent: string, total: string) => `Đang tải lên ${sent}/${total}`,
    uploadProgress: 'Tiến độ tải lên',
    cancelUpload: 'Hủy tải lên',
    uploadCancelled: 'Đã hủy tải lên',
    servedTooLarge: (size: string, max: string) =>
      `Khi bọc vào sandbox, trang nặng ${size}, vượt giới hạn ${max} cho một file của GitHub. Hãy làm trang nhẹ hơn.`,
    publishing: 'Đang đăng…',
    updating: 'Đang cập nhật…',
    indexMissingNothingPublished: (path: string) =>
      `Không thấy ${path} trên GitHub — chưa đăng gì cả.`,
    idTaken: (id: string) => `Link "${id}" đã được dùng. Hãy chọn link khác.`,
    published: 'Đã đăng',
    updated: 'Đã cập nhật',
    liveSoon: 'Lên sóng sau khoảng một phút:',
    publishFailed: 'Đăng thất bại',
    tokenRefused: 'GitHub từ chối token. Hãy cập nhật token rồi đăng lại — trang này vẫn được giữ.',
    publish: 'Đăng',
    savePublish: 'Lưu và đăng',
  },
})
