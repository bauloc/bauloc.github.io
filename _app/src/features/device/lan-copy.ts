import { localized } from '@/lib/i18n'
import { INTL_LOCALE } from '@/lib/locale'

import type { LanSource } from './helper/protocol'

/*
  Every word of "Devices on this network" (lan.ts, lan-kinds.ts, components/lan-dialog.tsx),
  in one place, in both of the site's languages (`localized({ en, vi })`): only the top-level
  groups are read at a time, and a value that needs a number or a name is a function, each
  language wording its own plurals and order. Brand and protocol names (AirPlay, mDNS, SSDP,
  Sonos, Matter, HomeKit) stay as their makers write them; device-screen terms follow Android's
  own Vietnamese (Wireless debugging = "Gỡ lỗi qua Wi‑Fi"), and iOS's ("Trust" = "Tin cậy").
*/

/** English has one plural; Vietnamese has none, so each language counts its own way. */
const plural = (n: number, one: string, many: string) =>
  n === 1 ? `1 ${one}` : `${n.toLocaleString('en')} ${many}`

/** Vietnamese: one noun whatever the count, the number written the Vietnamese way. */
const pluralVi = (n: number) => `${n.toLocaleString(INTL_LOCALE.vi)} thiết bị`

/** By service type: the words for what a device announces. */
const SERVICE: Readonly<Record<string, string>> = {
  '_adb._tcp': 'Network debugging (adb)',
  '_adb-tls-connect._tcp': 'Wireless debugging',
  '_adb-tls-pairing._tcp': 'Wireless debugging pairing',
  '_afpovertcp._tcp': 'File sharing (AFP)',
  '_airplay._tcp': 'AirPlay',
  '_amzn-wplay._tcp': 'Fire TV',
  '_androidtvremote2._tcp': 'Android TV Remote',
  '_apple-mobdev2._tcp': 'iPhone or iPad sync over Wi‑Fi',
  '_adisk._tcp': 'Time Machine',
  '_companion-link._tcp': 'Apple Continuity',
  '_device-info._tcp': 'Device information',
  '_elg._tcp': 'Elgato',
  '_esphomelib._tcp': 'ESPHome',
  '_googlecast._tcp': 'Google Cast',
  '_hap._tcp': 'HomeKit',
  '_hap._udp': 'HomeKit',
  '_http._tcp': 'Web page',
  '_http-alt._tcp': 'Web page',
  '_https._tcp': 'Web page (HTTPS)',
  '_hue._tcp': 'Philips Hue',
  '_ipp._tcp': 'Printer (IPP)',
  '_ipps._tcp': 'Printer (IPPS)',
  '_matter._tcp': 'Matter',
  '_matterc._udp': 'Matter',
  '_meshcop._udp': 'Thread',
  '_miio._udp': 'Xiaomi Home',
  '_nvstream._tcp': 'NVIDIA GameStream',
  '_pdl-datastream._tcp': 'Printer (raw)',
  '_printer._tcp': 'Printer (LPD)',
  '_privet._tcp': 'Printer (Privet)',
  '_raop._tcp': 'AirPlay audio',
  '_rdlink._tcp': 'Remote display',
  '_remotepairing._tcp': 'Remote pairing (Xcode)',
  '_rfb._tcp': 'Screen sharing (VNC)',
  '_scanner._tcp': 'Scanner',
  '_sftp-ssh._tcp': 'File transfer (SFTP)',
  '_shelly._tcp': 'Shelly',
  '_smb._tcp': 'File sharing (SMB)',
  '_sonos._tcp': 'Sonos',
  '_spotify-connect._tcp': 'Spotify Connect',
  '_ssh._tcp': 'Remote login (SSH)',
  '_uscan._tcp': 'Scanner (eSCL)',
  '_uscans._tcp': 'Scanner (eSCL)',
  '_workstation._tcp': 'Workstation',
}

/** The same, in Vietnamese: the plain words translated, the brand/protocol names kept. */
const SERVICE_VI: Readonly<Record<string, string>> = {
  '_adb._tcp': 'Gỡ lỗi qua mạng (adb)',
  '_adb-tls-connect._tcp': 'Gỡ lỗi qua Wi‑Fi',
  '_adb-tls-pairing._tcp': 'Ghép nối gỡ lỗi qua Wi‑Fi',
  '_afpovertcp._tcp': 'Chia sẻ tệp (AFP)',
  '_airplay._tcp': 'AirPlay',
  '_amzn-wplay._tcp': 'Fire TV',
  '_androidtvremote2._tcp': 'Điều khiển Android TV',
  '_apple-mobdev2._tcp': 'Đồng bộ iPhone hoặc iPad qua Wi‑Fi',
  '_adisk._tcp': 'Time Machine',
  '_companion-link._tcp': 'Apple Continuity',
  '_device-info._tcp': 'Thông tin thiết bị',
  '_elg._tcp': 'Elgato',
  '_esphomelib._tcp': 'ESPHome',
  '_googlecast._tcp': 'Google Cast',
  '_hap._tcp': 'HomeKit',
  '_hap._udp': 'HomeKit',
  '_http._tcp': 'Trang web',
  '_http-alt._tcp': 'Trang web',
  '_https._tcp': 'Trang web (HTTPS)',
  '_hue._tcp': 'Philips Hue',
  '_ipp._tcp': 'Máy in (IPP)',
  '_ipps._tcp': 'Máy in (IPPS)',
  '_matter._tcp': 'Matter',
  '_matterc._udp': 'Matter',
  '_meshcop._udp': 'Thread',
  '_miio._udp': 'Xiaomi Home',
  '_nvstream._tcp': 'NVIDIA GameStream',
  '_pdl-datastream._tcp': 'Máy in (raw)',
  '_printer._tcp': 'Máy in (LPD)',
  '_privet._tcp': 'Máy in (Privet)',
  '_raop._tcp': 'Âm thanh AirPlay',
  '_rdlink._tcp': 'Màn hình từ xa',
  '_remotepairing._tcp': 'Ghép nối từ xa (Xcode)',
  '_rfb._tcp': 'Chia sẻ màn hình (VNC)',
  '_scanner._tcp': 'Máy quét',
  '_sftp-ssh._tcp': 'Truyền tệp (SFTP)',
  '_shelly._tcp': 'Shelly',
  '_smb._tcp': 'Chia sẻ tệp (SMB)',
  '_sonos._tcp': 'Sonos',
  '_spotify-connect._tcp': 'Spotify Connect',
  '_ssh._tcp': 'Đăng nhập từ xa (SSH)',
  '_uscan._tcp': 'Máy quét (eSCL)',
  '_uscans._tcp': 'Máy quét (eSCL)',
  '_workstation._tcp': 'Máy trạm',
}

export const LAN_COPY = localized({
  en: {

    dialog: {
      title: 'Devices on this network',
      /** Before an answer, or when there is none. */
      about: 'Every device the helper finds on this computer’s network.',
      /** "11 devices on 192.168.68.0/24 · looked 5 s ago" */
      summary: (devices: number, networks: readonly string[], ago: string) =>
        `${plural(devices, 'device', 'devices')}${networks.length > 0 ? ` on ${networks.join(', ')}` : ''} · looked ${ago}`,
      ago: (seconds: number) =>
        seconds < 5
          ? 'just now'
          : seconds < 60
            ? `${String(seconds)} s ago`
            : seconds < 3600
              ? `${String(Math.floor(seconds / 60))} min ago`
              : `${String(Math.floor(seconds / 3600))} h ago`,
      refresh: 'Refresh',
      close: 'Close',
    },

    state: {
      helperOff: 'To list the devices on this network, start the local helper and pair this page.',
      setUp: 'Set up the helper',
      /** The skeleton list of the first look. */
      looking: 'Looking for devices…',
      noNetwork:
        'This computer isn’t on a local network, so there is nothing to list. Join a Wi‑Fi or wired network, then refresh.',
      unavailable: 'The helper couldn’t look for devices on this network. Try again.',
      empty: 'No devices found on this network',
      emptyStep: 'Check that this computer is on the Wi‑Fi or wired network you mean, then refresh.',
      noMatch: 'Nothing matches this filter',
      noMatchStep: 'Clear the search, or choose All.',
      /** The live region, once a Refresh the tester asked for has ended. */
      found: (n: number) => `Found ${plural(n, 'device', 'devices')}.`,
    },

    filter: {
      label: 'Kind',
      all: 'All',
      phones: 'Phones & tablets',
      tvs: 'TVs',
      computers: 'Computers',
      other: 'Other',
      /** A segment's name, its label hidden on a phone: "TVs, 2". */
      item: (label: string, n: number) => `${label}, ${String(n)}`,
    },

    search: {
      label: 'Search devices',
      placeholder: 'Search name or address',
    },

    /** The badges. */
    label: {
      self: 'This computer',
      router: 'Router',
      private: 'Private address',
    },

    /** What a device is called when nothing it says names it. */
    name: {
      unknown: 'Unknown device',
      self: 'This computer',
      /** "TP-Link router", "Espressif device". */
      maker: (maker: string, kind: string) => `${maker} ${kind}`,
      /** The sub-line of a device known only by its private hardware address. */
      privateOnly: 'Private address (likely a phone, tablet or laptop)',
    },

    /** The noun after a maker's name, by kind. */
    kind: {
      phone: 'phone',
      tablet: 'tablet',
      tv: 'TV',
      computer: 'computer',
      printer: 'printer',
      speaker: 'speaker',
      router: 'router',
      camera: 'camera',
      console: 'game console',
      watch: 'watch',
      storage: 'network storage',
      iot: 'device',
      unknown: 'device',
    },

    /** A family, when the model itself isn't known. */
    family: {
      iphone: 'iPhone',
      ipad: 'iPad',
      mac: 'Mac',
      appleTv: 'Apple TV',
      homePod: 'HomePod',
      watch: 'Apple Watch',
      android: 'Android',
      androidTv: 'Android TV',
      fireTv: 'Fire TV',
      apple: 'Apple',
    },

    /** The row's actions, and their names with the device's. */
    action: {
      connect: 'Connect',
      connecting: 'Connecting…',
      connectName: (name: string, address: string) => `Connect ${name} (${address})`,
      pair: 'Pair…',
      pairName: (name: string, address: string) => `Pair ${name} (${address})…`,
      show: 'Show',
      showName: (name: string) => `Show ${name} in the device list`,
      wifi: 'Connect over Wi‑Fi…',
      wifiName: (name: string, address: string) => `Connect ${name} (${address}) over Wi‑Fi…`,
      /**
       * The iPhone/iPad note, worded by the helper (lan-dialog.tsx). Off macOS the page reuses
       * status.ts's NEEDS_MAC with no command; on a Mac these two cover whether the helper already
       * runs with --wifi. The flag is shown as code in the sentence and again in the command.
       */
      iphone: {
        /** macOS, the Wi‑Fi lane already on: it is in the list, or a cable brings it in once. */
        listed:
          'If it isn’t in the device list yet, plug it into this computer once with a cable and tap Trust.',
        /** macOS, no Wi‑Fi lane yet: a cable once, or restart the helper with the flag (shown after). */
        restart:
          'To use it in Device Lab, plug it into this computer once with a cable and tap Trust. To use it without the cable, stop the helper (Ctrl+C) and start it again with ',
        /** The flag the restart note ends on, and the tail of its command. */
        wifiFlag: '--wifi',
      },
    },

    /** The facts a row shows once opened. */
    facts: {
      label: (name: string) => `About ${name}`,
      address: 'Address',
      copyAddress: 'Copy address',
      hostnames: 'Host name',
      model: 'Model',
      maker: 'Maker',
      services: 'Announces',
      found: 'Found by',
    },

    /** How the helper came to know a device. */
    source: {
      reply: 'a reply',
      neighbors: 'the neighbour table',
      mdns: 'mDNS',
      ssdp: 'SSDP',
      reverse: 'a name lookup',
      gateway: 'the default route',
      self: 'this computer’s own address',
    } satisfies Readonly<Record<LanSource, string>>,

    /** The services a device announces, in plain words; any other shows as its type. */
    service: SERVICE,

    /** Under the list: what this list could not use on this computer. */
    footer: {
      makersHidden: (some: boolean): string =>
        some
          ? 'Some device makers aren’t shown: macOS doesn’t share device hardware addresses with the helper.'
          : 'Device makers aren’t shown: macOS doesn’t share device hardware addresses with the helper.',
      avahi: 'Install avahi-utils for device names:',
      avahiCommand: 'sudo apt install avahi-utils',
      partial: (network: string, scanned: number, size: number) =>
        `On ${network}, ${scanned.toLocaleString('en')} of its ${size.toLocaleString('en')} addresses were checked; devices that announce themselves are listed from all of it.`,
      truncated: (n: number) => `Only the first ${n.toLocaleString('en')} devices are listed.`,
    },
  },

  vi: {

    dialog: {
      title: 'Thiết bị trên mạng này',
      about: 'Mọi thiết bị helper tìm thấy trên mạng của máy tính này.',
      summary: (devices: number, networks: readonly string[], ago: string) =>
        `${pluralVi(devices)}${networks.length > 0 ? ` trên ${networks.join(', ')}` : ''} · đã xem ${ago}`,
      ago: (seconds: number) =>
        seconds < 5
          ? 'vừa xong'
          : seconds < 60
            ? `${String(seconds)} giây trước`
            : seconds < 3600
              ? `${String(Math.floor(seconds / 60))} phút trước`
              : `${String(Math.floor(seconds / 3600))} giờ trước`,
      refresh: 'Làm mới',
      close: 'Đóng',
    },

    state: {
      helperOff: 'Để liệt kê thiết bị trên mạng này, hãy chạy helper cục bộ và ghép nối trang này.',
      setUp: 'Thiết lập helper',
      looking: 'Đang tìm thiết bị…',
      noNetwork:
        'Máy tính này không ở trong mạng cục bộ nào nên không có gì để liệt kê. Hãy kết nối vào một mạng Wi‑Fi hoặc mạng dây, rồi làm mới.',
      unavailable: 'Helper không tìm được thiết bị trên mạng này. Hãy thử lại.',
      empty: 'Không tìm thấy thiết bị nào trên mạng này',
      emptyStep:
        'Hãy kiểm tra máy tính này có đang ở đúng mạng Wi‑Fi hoặc mạng dây bạn muốn không, rồi làm mới.',
      noMatch: 'Không có gì khớp với bộ lọc này',
      noMatchStep: 'Hãy xoá ô tìm kiếm, hoặc chọn Tất cả.',
      found: (n: number) => `Đã tìm thấy ${pluralVi(n)}.`,
    },

    filter: {
      label: 'Loại',
      all: 'Tất cả',
      phones: 'Điện thoại & máy tính bảng',
      tvs: 'TV',
      computers: 'Máy tính',
      other: 'Khác',
      item: (label: string, n: number) => `${label}, ${String(n)}`,
    },

    search: {
      label: 'Tìm kiếm thiết bị',
      placeholder: 'Tìm theo tên hoặc địa chỉ',
    },

    label: {
      self: 'Máy này',
      router: 'Bộ định tuyến',
      private: 'Địa chỉ riêng tư',
    },

    name: {
      unknown: 'Thiết bị lạ',
      self: 'Máy này',
      /** Vietnamese names the kind first: "Bộ định tuyến TP-Link", "Thiết bị IoT Espressif". */
      maker: (maker: string, kind: string) => `${kind} ${maker}`,
      privateOnly: 'Địa chỉ riêng tư (có thể là điện thoại, máy tính bảng hoặc laptop)',
    },

    kind: {
      phone: 'Điện thoại',
      tablet: 'Máy tính bảng',
      tv: 'TV',
      computer: 'Máy tính',
      printer: 'Máy in',
      speaker: 'Loa',
      router: 'Bộ định tuyến',
      camera: 'Camera',
      console: 'Máy chơi game',
      watch: 'Đồng hồ',
      storage: 'Ổ lưu trữ mạng',
      iot: 'Thiết bị IoT',
      unknown: 'Thiết bị',
    },

    family: {
      iphone: 'iPhone',
      ipad: 'iPad',
      mac: 'Mac',
      appleTv: 'Apple TV',
      homePod: 'HomePod',
      watch: 'Apple Watch',
      android: 'Android',
      androidTv: 'Android TV',
      fireTv: 'Fire TV',
      apple: 'Apple',
    },

    action: {
      connect: 'Kết nối',
      connecting: 'Đang kết nối…',
      connectName: (name: string, address: string) => `Kết nối ${name} (${address})`,
      pair: 'Ghép nối…',
      pairName: (name: string, address: string) => `Ghép nối ${name} (${address})…`,
      show: 'Xem',
      showName: (name: string) => `Xem ${name} trong danh sách thiết bị`,
      wifi: 'Kết nối qua Wi‑Fi…',
      wifiName: (name: string, address: string) => `Kết nối ${name} (${address}) qua Wi‑Fi…`,
      iphone: {
        listed:
          'Nếu thiết bị chưa có trong danh sách, hãy cắm nó vào máy tính này một lần bằng cáp rồi chạm Tin cậy.',
        restart:
          'Để dùng trong Device Lab, hãy cắm thiết bị vào máy tính này một lần bằng cáp rồi chạm Tin cậy. Để dùng mà không cần cáp, hãy dừng helper (Ctrl+C) rồi chạy lại với ',
        wifiFlag: '--wifi',
      },
    },

    facts: {
      label: (name: string) => `Thông tin về ${name}`,
      address: 'Địa chỉ',
      copyAddress: 'Sao chép địa chỉ',
      hostnames: 'Tên máy',
      model: 'Kiểu máy',
      maker: 'Nhà sản xuất',
      services: 'Dịch vụ',
      found: 'Tìm thấy qua',
    },

    source: {
      reply: 'một phản hồi',
      neighbors: 'bảng lân cận',
      mdns: 'mDNS',
      ssdp: 'SSDP',
      reverse: 'tra cứu tên',
      gateway: 'tuyến mặc định',
      self: 'địa chỉ của chính máy này',
    } satisfies Readonly<Record<LanSource, string>>,

    service: SERVICE_VI,

    footer: {
      makersHidden: (some: boolean): string =>
        some
          ? 'Một số nhà sản xuất thiết bị không hiển thị: macOS không chia sẻ địa chỉ phần cứng của thiết bị cho helper.'
          : 'Không hiển thị nhà sản xuất thiết bị: macOS không chia sẻ địa chỉ phần cứng của thiết bị cho helper.',
      avahi: 'Hãy cài avahi-utils để có tên thiết bị:',
      avahiCommand: 'sudo apt install avahi-utils',
      partial: (network: string, scanned: number, size: number) =>
        `Trên ${network}, đã kiểm tra ${scanned.toLocaleString(INTL_LOCALE.vi)} trong ${size.toLocaleString(INTL_LOCALE.vi)} địa chỉ; các thiết bị tự quảng bá vẫn được liệt kê từ toàn bộ dải.`,
      truncated: (n: number) =>
        `Chỉ liệt kê ${n.toLocaleString(INTL_LOCALE.vi)} thiết bị đầu tiên.`,
    },
  },
})
