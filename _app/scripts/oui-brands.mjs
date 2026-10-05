// Curated MAC-vendor (OUI) brands for a page that lists the devices on a home or
// small-office LAN. build-oui.mjs matches every IEEE MA-L "Organization Name"
// against these patterns and writes oui-table.json.
//
// Entry shape: { name, match: RegExp[], hint? }
//   name  - the short display name people know (not the legal name).
//   match - case-insensitive patterns tested against the trimmed IEEE organization
//           name. Each IEEE name may match at most one entry (the build fails
//           otherwise), and every pattern must match at least one IEEE name.
//   hint  - optional device-kind guess, one of HINTS. Leave it out when the maker's
//           MAC addresses show up on very different kinds of device.
//
// Several entries may share a name when the hint depends on the legal entity
// (e.g. "Huawei Device" makes phones, "HUAWEI TECHNOLOGIES" makes almost everything).
// README.md explains the hint choices.

export const HINTS = ['phone', 'computer', 'router', 'tv', 'speaker', 'printer', 'camera', 'console', 'iot', 'storage'];

export const BRANDS = [
  // ── Makers of many kinds of device: name only ──────────────────────────────
  { name: 'Apple', match: [/^Apple,? Inc/i] },
  { name: 'Samsung', match: [/^Samsung Electr/i, /^Samsung Semiconductor/i] },
  { name: 'Google', match: [/^Google,? Inc/i] },
  { name: 'Amazon', match: [/^Amazon Technologies/i, /^Amazon\.com/i] },
  { name: 'Microsoft', match: [/^Microsoft\b/i] },
  { name: 'Xiaomi', match: [/xiaomi/i] },
  { name: 'Huawei', match: [/^Huawei Technologies/i] },
  { name: 'LG', match: [/^LG (Electr|Electornics|Innotek)/i] },
  { name: 'Sony', match: [/^Sony Corp/i, /^Sony Imaging/i] },
  { name: 'Panasonic', match: [/^Panasonic/i] },
  { name: 'Sharp', match: [/^SHARP Corporation/i] },
  { name: 'Toshiba', match: [/^Toshiba( Corp(oration|\.)?)?$/i, /^Toshiba (Visual|Client) Solutions/i] },
  { name: 'Hisense', match: [/^Qingdao Hisense (Communications|Mobile|Smart)/i, /^Hisense (Mobile|Broadband|Home)/i] },
  { name: 'Kyocera', match: [/^KYOCERA Corporation/i, /^Kyocera Wireless/i] },
  { name: 'Cisco', match: [/^Cisco Systems/i, /^Cisco SPVTG/i] },
  { name: 'HP', match: [/^HP Inc\b/i, /^Hewlett Packard$/i] },
  { name: 'ASUS', match: [/^ASUSTek/i, /^Asus Network/i] },
  { name: 'Belkin', match: [/^Belkin/i] },
  { name: 'Edimax', match: [/^Edimax/i] },
  { name: 'Ugreen', match: [/^Ugreen/i] },
  { name: 'eufy', match: [/^Fantasia Trading/i] }, // Anker's US company: eufy cameras and robot vacuums
  { name: 'Garmin', match: [/^Garmin/i] },
  { name: 'Fitbit', match: [/^Fitbit/i] },
  { name: 'Zebra', match: [/^Zebra Technologies/i] },
  { name: 'Sunmi', match: [/^Shanghai Sunmi/i] },
  { name: 'Tesla', match: [/^Tesla,? ?Inc/i] }, // cars and Powerwall gateways on home Wi-Fi
  { name: 'Logitech', match: [/Logitech/i] },
  { name: 'Vingroup', match: [/^VINGROUP/i] },
  { name: 'Bkav', match: [/^BKAV/i] },

  // Wi-Fi/Bluetooth module and chip makers whose parts end up in anything.
  { name: 'Foxconn', match: [/^Hon ?Hai/i, /^Foxconn/i, /^Cloud Network Technology/i, /^Ambit Microsystems/i] },
  { name: 'Murata', match: [/^Murata Manufacturing/i] },
  { name: 'Pegatron', match: [/^PEGATRON/i] },
  { name: 'USI', match: [/^Universal Global Scientific/i] },
  { name: 'AMPAK', match: [/^AMPAK/i] },
  { name: 'Fn-Link', match: [/FN-LINK/i] },
  { name: 'LB-Link', match: [/^Shenzhen Bilian/i] },
  { name: 'Gaoshengda', match: [/Gaoshengda/i, /^GSD VIET ?NAM/i] },
  { name: 'MediaTek', match: [/^MediaTek/i] },
  { name: 'Qualcomm', match: [/^Qualcomm/i, /^Atheros/i] },
  { name: 'Broadcom', match: [/^Broadcom/i] },
  { name: 'WNC', match: [/^WNC Corp/i] }, // Wistron NeWeb: Wi-Fi modules, set-top boxes, gateways
  { name: 'Allwinner', match: [/^All ?Winner/i] }, // default MACs of cheap Android boxes and tablets

  // ── Phones and tablets (desk IP phones too) ─────────────────────────────────
  { name: 'Huawei', match: [/^Huawei Device/i], hint: 'phone' },
  { name: 'Honor', match: [/^Honor Device/i], hint: 'phone' },
  { name: 'OPPO', match: [/^GUANGDONG OPPO/i], hint: 'phone' },
  { name: 'vivo', match: [/^vivo Mobile/i], hint: 'phone' },
  { name: 'realme', match: [/^Realme/i], hint: 'phone' },
  { name: 'OnePlus', match: [/^OnePlus/i], hint: 'phone' },
  { name: 'Motorola', match: [/^Motorola Mobility/i, /^Motorola ?\(Wuhan\) Mobility/i], hint: 'phone' },
  { name: 'Lenovo', match: [/^Lenovo (Mobile|Future) Communication/i], hint: 'phone' },
  { name: 'Nokia', match: [/^Nokia Corporation/i, /^Nokia Danmark/i, /^HMD Global/i], hint: 'phone' },
  { name: 'TCL', match: [/^TCT mobile/i, /^Huizhou TCL Communication/i], hint: 'phone' },
  { name: 'TECNO', match: [/^TECNO MOBILE/i], hint: 'phone' },
  { name: 'itel', match: [/^ITEL MOBILE/i], hint: 'phone' },
  { name: 'Infinix', match: [/^Infinix/i], hint: 'phone' },
  { name: 'Meizu', match: [/^MEIZU/i], hint: 'phone' },
  { name: 'Nothing', match: [/^Nothing Technology/i], hint: 'phone' },
  { name: 'nubia', match: [/^Nubia Technology/i], hint: 'phone' },
  { name: 'Fairphone', match: [/^Fairphone/i], hint: 'phone' },
  { name: 'HTC', match: [/^HTC Corporation/i], hint: 'phone' },
  { name: 'TINNO', match: [/TINNO Mobile/i], hint: 'phone' },
  { name: 'Yealink', match: [/YEALINK/i], hint: 'phone' },
  { name: 'Grandstream', match: [/^Grandstream/i], hint: 'phone' },
  { name: 'Fanvil', match: [/^Fanvil/i], hint: 'phone' },
  { name: 'Poly', match: [/^Polycom/i, /^Poly$/i, /^PLANTRONICS/i], hint: 'phone' },

  // ── PCs, laptops, and the network chips/modules that mostly sit inside them ──
  { name: 'Intel', match: [/^Intel (Corporat|Wireless)/i], hint: 'computer' },
  { name: 'Realtek', match: [/^Realtek/i], hint: 'computer' },
  { name: 'Liteon', match: [/^Lite-?on(?! clean)/i], hint: 'computer' },
  { name: 'AzureWave', match: [/^AzureWave/i], hint: 'computer' },
  { name: 'ASIX', match: [/^ASIX Electronics/i], hint: 'computer' }, // USB Ethernet adapters
  // Virtual machines bridged onto the LAN
  { name: 'VMware', match: [/^VMware/i], hint: 'computer' },
  { name: 'VirtualBox', match: [/^PCS Systemtechnik/i], hint: 'computer' }, // 08:00:27
  { name: 'Parallels', match: [/^Parallels, Inc/i], hint: 'computer' },
  { name: 'Dell', match: [/^Dell\b/i], hint: 'computer' },
  { name: 'Lenovo', match: [/^Lenovo ?(\(Beijing\)|Information|$)/i, /Lenovo Japan/i, /^LCFC/i], hint: 'computer' },
  { name: 'Acer', match: [/^Acer (Inc|Incorporated|Computer)/i], hint: 'computer' },
  { name: 'MSI', match: [/^Micro-Star/i, /^MSI\b/i], hint: 'computer' },
  { name: 'Gigabyte', match: [/^GIGA-BYTE TECHNOLOGY/i, /^Giga-Byte$/i], hint: 'computer' },
  { name: 'ASRock', match: [/^ASRock/i], hint: 'computer' },
  { name: 'ECS', match: [/^Elitegroup/i], hint: 'computer' },
  { name: 'Fujitsu', match: [/^Fujitsu (Limited|Client Computing|Technology Solutions|Siemens Computers)/i], hint: 'computer' },
  { name: 'Framework', match: [/^Framework Computer/i], hint: 'computer' },
  { name: 'Raspberry Pi', match: [/^Raspberry Pi/i], hint: 'computer' },
  { name: 'Supermicro', match: [/^Super Micro Computer/i], hint: 'computer' },
  { name: 'Quanta', match: [/^Quanta Computer/i], hint: 'computer' },
  { name: 'Compal', match: [/^Compal (Information|Electronics)/i], hint: 'computer' },
  { name: 'Wistron', match: [/^Wistron/i], hint: 'computer' },
  { name: 'Inventec', match: [/^Inventec ?(Corporation|\(Chongqing\))/i], hint: 'computer' },
  { name: 'Foxconn', match: [/^Chongqing Fugui/i], hint: 'computer' }, // Foxconn's notebook plant

  // ── Routers, modems, Wi-Fi and other network gear ──────────────────────────
  { name: 'TP-Link', match: [/^TP-?LINK/i], hint: 'router' },
  { name: 'Mercusys', match: [/Mercury Communication Technologies/i, /^MERCUSYS/i], hint: 'router' },
  { name: 'Tenda', match: [/^(SHEN ZHEN )?Tenda Technology/i], hint: 'router' },
  { name: 'TOTOLINK', match: [/^Zioncom/i, /^TOTOLINK/i], hint: 'router' },
  { name: 'Netgear', match: [/^NETGEAR/i], hint: 'router' },
  { name: 'D-Link', match: [/^D-Link/i], hint: 'router' },
  { name: 'Linksys', match: [/linksys/i], hint: 'router' },
  { name: 'eero', match: [/^eero/i], hint: 'router' },
  { name: 'Ubiquiti', match: [/^Ubiquiti/i], hint: 'router' },
  { name: 'MikroTik', match: [/^Routerboard\.com/i], hint: 'router' },
  { name: 'Meraki', match: [/^Cisco Meraki/i], hint: 'router' },
  { name: 'Ruckus', match: [/^Ruckus/i], hint: 'router' },
  { name: 'HPE', match: [/^Hewlett Packard Enterprise/i, /^ProCurve/i, /^HPN Supply Chain/i], hint: 'router' },
  { name: 'H3C', match: [/H3C/i], hint: 'router' },
  { name: 'Ruijie', match: [/Ruijie/i, /^Fujian Star-Net/i, /^Star-Net$/i], hint: 'router' },
  { name: 'DrayTek', match: [/^DrayTek/i], hint: 'router' },
  { name: 'Zyxel', match: [/^Zyxel/i], hint: 'router' },
  { name: 'Fortinet', match: [/^Fortinet/i], hint: 'router' },
  { name: 'Sophos', match: [/^Sophos/i], hint: 'router' },
  { name: 'SonicWall', match: [/^SonicWall/i], hint: 'router' },
  { name: 'WatchGuard', match: [/^WatchGuard Technologies/i], hint: 'router' },
  { name: 'Buffalo', match: [/^BUFFALO/i], hint: 'router' },
  { name: 'FRITZ!', match: [/^AVM (Audiovisuelles|GmbH)/i, /^FRITZ!/i], hint: 'router' },
  { name: 'devolo', match: [/^devolo/i], hint: 'router' },
  { name: 'Netis', match: [/^Netis Technology/i], hint: 'router' },
  { name: 'Cudy', match: [/^Shenzhen Cudy/i], hint: 'router' },
  { name: 'COMFAST', match: [/Four Seas Global Link/i], hint: 'router' },
  { name: 'EnGenius', match: [/^EnGenius/i, /^Senao/i], hint: 'router' },
  // ISP modems, ONTs and gateways
  { name: 'ZTE', match: [/^ZTE Corporation/i], hint: 'router' },
  { name: 'Fiberhome', match: [/fiberhome/i], hint: 'router' },
  { name: 'Nokia', match: [/^Nokia$/i, /^Nokia (Shanghai Bell|Solutions|Siemens|Bell)/i], hint: 'router' },
  { name: 'Alcatel-Lucent', match: [/^Alcatel[- ]Lucent/i], hint: 'router' },
  { name: 'VNPT', match: [/VNPT/i, /^Vietnam Post and Telecommunication Industry/i], hint: 'router' },
  { name: 'Viettel', match: [/^Viettel/i], hint: 'router' },
  { name: 'Sagemcom', match: [/^Sagemcom/i], hint: 'router' },
  { name: 'Technicolor', match: [/^Vantiva/i, /^Technicolor/i, /^Thomson Telecom/i], hint: 'router' },
  { name: 'ARRIS', match: [/^CommScope$/i, /^Arris$/i, /^Motorola(,| -) (BSG|Broadband)/i], hint: 'router' },
  { name: 'Arcadyan', match: [/^Arcadyan/i], hint: 'router' },
  { name: 'Askey', match: [/^ASKEY/i], hint: 'router' },
  { name: 'Sercomm', match: [/^Sercomm/i, /^SerNet \(Suzhou\)/i], hint: 'router' },
  { name: 'DZS', match: [/^DASAN (CO\.|Networks|Newtork Solutions|Network Solutions)/i, /^Zhone/i], hint: 'router' },
  { name: 'CIG', match: [/^Cambridge Industries/i, /^CIG Shanghai/i], hint: 'router' },
  { name: 'Hitron', match: [/^Hitron/i], hint: 'router' },
  { name: 'Compal', match: [/^Compal Broadband/i], hint: 'router' },
  { name: 'Humax', match: [/^HUMAX NETWORKS/i], hint: 'router' },
  { name: 'Actiontec', match: [/^Actiontec/i], hint: 'router' },
  { name: 'Calix', match: [/^Calix/i], hint: 'router' },
  { name: 'Adtran', match: [/^Adtran Inc/i], hint: 'router' },

  // ── TVs, set-top and streaming boxes ───────────────────────────────────────
  { name: 'Roku', match: [/^Roku/i], hint: 'tv' },
  { name: 'Vizio', match: [/^Vizio/i], hint: 'tv' },
  { name: 'TCL', match: [/^TCL (King|Technoly|MOKA)/i, /^Shenzhen TCL New Technology/i], hint: 'tv' },
  { name: 'Hisense', match: [/^Hisense (Visual|Electric)/i, /^Qingdao Hisense Electronics/i, /^Qingdao Intelligent&Precise/i], hint: 'tv' },
  { name: 'Skyworth', match: [/skyworth/i, /Chuangwei/i], hint: 'tv' },
  { name: 'Sony', match: [/^Sony (Home Entertainment|Video|Visual)/i], hint: 'tv' },
  { name: 'Philips', match: [/^TP Vision/i], hint: 'tv' },
  { name: 'CVTE', match: [/^Guangzhou Shiyuan/i], hint: 'tv' },
  { name: 'Humax', match: [/^HUMAX Co/i], hint: 'tv' },
  { name: 'NVIDIA', match: [/^NVIDIA/i], hint: 'tv' }, // Shield TV
  { name: 'Amlogic', match: [/^Amlogic/i], hint: 'tv' }, // default MACs of Android TV boxes
  { name: 'SEI Robotics', match: [/SEI Robotics/i], hint: 'tv' }, // operator Android TV boxes

  // ── Speakers and audio ─────────────────────────────────────────────────────
  { name: 'Sonos', match: [/^Sonos,? Inc/i], hint: 'speaker' },
  { name: 'Bose', match: [/^Bose Corp/i], hint: 'speaker' },
  { name: 'JBL', match: [/^Harman (Consumer|Multimedia)/i, /^JBL\b/i], hint: 'speaker' },
  { name: 'Yamaha', match: [/^YAMAHA CORPORATION/i], hint: 'speaker' },
  { name: 'Denon & Marantz', match: [/^D&M Holdings/i, /^Sound United/i], hint: 'speaker' },
  { name: 'Bang & Olufsen', match: [/^Bang & Olufsen A\/S/i], hint: 'speaker' },
  { name: 'Sennheiser', match: [/^Sennheiser/i], hint: 'speaker' },
  { name: 'Edifier', match: [/^Edifier/i], hint: 'speaker' },

  // ── Printers ───────────────────────────────────────────────────────────────
  { name: 'Canon', match: [/^Canon\b/i], hint: 'printer' },
  { name: 'Epson', match: [/^Seiko Epson/i], hint: 'printer' },
  { name: 'Brother', match: [/^Brother Industries/i], hint: 'printer' },
  { name: 'Xerox', match: [/^Xerox Corporation/i], hint: 'printer' },
  { name: 'Fujifilm', match: [/^FUJIFILM Business Innovation/i], hint: 'printer' }, // formerly Fuji Xerox
  { name: 'Ricoh', match: [/^Ricoh Company/i, /^Tohoku Ricoh/i], hint: 'printer' },
  { name: 'Kyocera', match: [/^KYOCERA Document/i], hint: 'printer' },
  { name: 'Konica Minolta', match: [/^Konica Minolta/i], hint: 'printer' },
  { name: 'Toshiba', match: [/^Toshiba TEC/i], hint: 'printer' },
  { name: 'Lexmark', match: [/^Lexmark/i], hint: 'printer' },
  { name: 'OKI', match: [/^Oki Electric Industry/i], hint: 'printer' },
  { name: 'Pantum', match: [/Pantum/i], hint: 'printer' },
  { name: 'Bixolon', match: [/^BIXOLON/i], hint: 'printer' },

  // ── Cameras, doorbells, video recorders ────────────────────────────────────
  { name: 'Hikvision', match: [/hikvision/i], hint: 'camera' },
  { name: 'EZVIZ', match: [/ezviz/i], hint: 'camera' },
  { name: 'Dahua', match: [/dahua/i], hint: 'camera' },
  { name: 'Imou', match: [/Huacheng Network/i], hint: 'camera' }, // Dahua's consumer brand
  { name: 'Uniview', match: [/Uniview/i], hint: 'camera' },
  { name: 'Tiandy', match: [/^Tiandy/i], hint: 'camera' },
  { name: 'Hanwha Vision', match: [/^Hanwha Vision/i, /^Samsung Techwin/i], hint: 'camera' },
  { name: 'KBVision', match: [/^KBVision/i], hint: 'camera' },
  { name: 'Axis', match: [/^Axis Communications/i], hint: 'camera' },
  { name: 'Vivotek', match: [/^Vivotek/i], hint: 'camera' },
  { name: 'Reolink', match: [/^Reolink/i], hint: 'camera' },
  { name: 'Imilab', match: [/Imilab/i], hint: 'camera' }, // Xiaomi Mi Home cameras (ex-Chuangmi)
  { name: 'YI', match: [/^Shanghai Xiaoyi/i], hint: 'camera' },
  { name: 'Ring', match: [/^Ring LLC/i], hint: 'camera' },
  { name: 'Blink', match: [/^Blink by Amazon/i], hint: 'camera' },
  { name: 'Arlo', match: [/^Arlo Technolog/i], hint: 'camera' },
  { name: 'Wyze', match: [/^Wyze/i], hint: 'camera' },

  // ── Game consoles and VR ───────────────────────────────────────────────────
  { name: 'Nintendo', match: [/^Nintendo/i], hint: 'console' },
  { name: 'PlayStation', match: [/^Sony (Interactive|Computer) Entertainment/i], hint: 'console' },
  { name: 'Valve', match: [/^Valve Corp/i], hint: 'console' },
  { name: 'Meta', match: [/^Meta Platforms/i, /^Facebook/i, /^Oculus/i], hint: 'console' }, // Quest headsets

  // ── Smart home, appliances and IoT chips ───────────────────────────────────
  { name: 'Espressif', match: [/^Espressif/i], hint: 'iot' },
  { name: 'Tuya', match: [/^Tuya/i], hint: 'iot' },
  { name: 'Silicon Labs', match: [/^Silicon Laboratories/i], hint: 'iot' },
  { name: 'Texas Instruments', match: [/^Texas Instruments/i], hint: 'iot' },
  { name: 'NXP', match: [/^NXP/i], hint: 'iot' },
  { name: 'Nordic', match: [/^Nordic Semiconductor/i], hint: 'iot' },
  { name: 'Microchip', match: [/^Microchip Technolog/i], hint: 'iot' },
  { name: 'AltoBeam', match: [/^AltoBeam/i], hint: 'iot' },
  { name: 'iComm', match: [/iComm Semiconductor/i], hint: 'iot' },
  { name: 'AI-Link', match: [/AI-Link Technology/i], hint: 'iot' },
  { name: 'Bouffalo Lab', match: [/^Bouffalo/i], hint: 'iot' },
  { name: 'Shelly', match: [/^Shelly/i], hint: 'iot' },
  { name: 'Philips Hue', match: [/^Signify/i, /^Philips Lighting/i], hint: 'iot' },
  { name: 'WiZ', match: [/^WiZ\b/i], hint: 'iot' },
  { name: 'IKEA', match: [/^IKEA/i], hint: 'iot' },
  { name: 'LIFX', match: [/^LIFI Labs/i], hint: 'iot' },
  { name: 'Nanoleaf', match: [/^Nanoleaf/i], hint: 'iot' },
  { name: 'Meross', match: [/Meross/i], hint: 'iot' },
  { name: 'SwitchBot', match: [/^Woan Technology/i], hint: 'iot' },
  { name: 'Broadlink', match: [/^Hangzhou BroadLink/i], hint: 'iot' },
  { name: 'Aqara', match: [/^Lumi United/i], hint: 'iot' },
  { name: 'Yeelight', match: [/^Yeelink/i], hint: 'iot' },
  { name: 'Google Nest', match: [/^Nest Labs/i], hint: 'iot' },
  { name: 'ecobee', match: [/^ecobee/i], hint: 'iot' },
  { name: 'Netatmo', match: [/^Netatmo/i], hint: 'iot' },
  { name: 'tado', match: [/^tado/i], hint: 'iot' },
  { name: 'Withings', match: [/^Withings/i], hint: 'iot' },
  { name: 'Roborock', match: [/Roborock/i], hint: 'iot' },
  { name: 'Dreame', match: [/^Dreame/i], hint: 'iot' },
  { name: 'iRobot', match: [/^iRobot/i], hint: 'iot' },
  { name: 'Midea', match: [/^GD Midea/i, /^Midea Group/i], hint: 'iot' },
  { name: 'Haier', match: [/^Qingdao Haier ?(Technology|Intelligent|Multimedia)/i, /^Haier( Group|$)/i], hint: 'iot' },
  { name: 'Gree', match: [/^Gree Electric/i], hint: 'iot' },
  { name: 'Daikin', match: [/^Daikin/i], hint: 'iot' },
  { name: 'Dyson', match: [/^Dyson/i], hint: 'iot' },
  { name: 'Bosch/Siemens', match: [/^BSH /i], hint: 'iot' }, // BSH Home Connect appliances

  // ── Network storage ────────────────────────────────────────────────────────
  { name: 'Synology', match: [/^Synology/i], hint: 'storage' },
  { name: 'QNAP', match: [/^QNAP/i], hint: 'storage' },
  { name: 'Western Digital', match: [/Western Digital/i], hint: 'storage' },
  { name: 'Seagate', match: [/^Seagate/i], hint: 'storage' },
];
