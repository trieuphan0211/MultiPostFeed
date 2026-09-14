# MultiPostFeed

Extension Chrome (Manifest V3) để soạn một bài (chữ + ảnh) rồi đăng lần lượt lên các nhóm Facebook đã lưu. Extension điều khiển composer trên trang Facebook đã đăng nhập — không gọi Graph API.

**Phiên bản:** 1.0.0

## Tính năng

- Soạn bài chữ + tối đa 10 ảnh, draft được lưu lại khi đóng side panel
- Thêm nhóm bằng URL, từ tab đang mở, hoặc quét danh sách nhóm đã tham gia
- Hàng đợi đăng tuần tự, delay ngẫu nhiên giữa các nhóm (20–180 giây)
- Tạm dừng / tiếp tục / bỏ qua / dừng giữa chừng
- Nhóm lỗi được bỏ qua và chạy nhóm kế; cuối hàng đợi có thể đăng lại các nhóm lỗi
- Bỏ qua nhóm đã đăng cùng nội dung (tránh đăng trùng)
- Lịch sử 200 dòng gần nhất: lọc, mở bài, sao chép permalink, đăng lại
- Khôi phục hàng đợi nếu service worker bị Chrome tắt giữa chừng

## Cài đặt

Extension chưa lên Chrome Web Store. Cài từ source:

1. Clone repo hoặc giải nén mã nguồn.
2. Mở Chrome → `chrome://extensions` → bật **Developer mode**.
3. **Load unpacked** → chọn thư mục gốc `MultiPostFeed` (thư mục chứa `manifest.json`).
4. Bấm icon extension trên thanh công cụ để mở side panel.

Cần một tab Facebook đã đăng nhập (`facebook.com` hoặc `web.facebook.com`). Không mở được composer nếu đang ở trang login.

## Cách dùng

1. Mở Facebook đã đăng nhập, rồi mở MultiPostFeed.
2. **Soạn bài:** nhập nội dung, thêm ảnh nếu cần.
3. **Nhóm:**
   - *Quét nhóm đã tham gia* — mở `/groups/joins`, cuộn và thu thập nhóm.
   - *Thêm URL* — dán `https://www.facebook.com/groups/<slug>/`.
   - *Thêm nhóm hiện tại* — lấy nhóm từ tab Facebook đang mở.
4. Chọn nhóm cần đăng (lọc tên/URL, chọn tất cả / đang hiện).
5. Đặt khoảng delay ngẫu nhiên giữa các nhóm (mặc định 30–60 giây).
6. **Bắt đầu đăng.** Extension lần lượt mở từng nhóm, điền composer, gắn ảnh, bấm Đăng.
7. Theo dõi hàng đợi. Nhóm lỗi hiện ở *Chưa đăng được* — có thể **Đăng lại các nhóm lỗi**.

Từ 10 nhóm trở lên, side panel hỏi xác nhận trước khi chạy.

## Giới hạn và lưu ý

| Hạng mục | Giá trị |
| --- | --- |
| Ảnh mỗi bài | Tối đa 10 |
| Dung lượng mỗi ảnh | Tối đa 8 MB (trước khi nén) |
| Nén ảnh | JPEG, cạnh dài tối đa 1600px, quality 0.82 |
| Delay giữa nhóm | 20–180 giây |
| Lịch sử | 200 dòng, mới nhất trước |
| Timeout đăng một nhóm | 120 giây |
| Timeout quét nhóm | 120 giây |

- Facebook đổi DOM thường xuyên. Selector dựa trên nhãn tiếng Việt/Anh của composer; UI mới có thể làm hỏng bước điền chữ, gắn ảnh hoặc bấm Đăng.
- Nhóm cần duyệt bài sẽ đăng thành công ở phía composer nhưng permalink có thể chưa có ngay.
- Cùng một nội dung + cùng bộ ảnh sẽ **không đăng lại** nhóm đã `posted`. Đổi nội dung hoặc xóa dòng lịch sử của nhóm đó nếu muốn đăng lại.
- Service worker bị Chrome kill khi đang `running` → hàng đợi chuyển `paused`, cần bấm **Tiếp tục**.
- Dùng tài khoản của chính bạn, tôn trọng quy định nhóm và [Điều khoản Facebook](https://www.facebook.com/policies). Đăng hàng loạt có thể bị hạn chế.

## Cấu trúc thư mục

```
MultiPostFeed/
├── manifest.json                 # MV3, quyền, side panel, content script
├── background/service-worker.js  # Hàng đợi, tab Facebook, scan, MAIN-world hooks
├── content/facebook-poster.js    # Mở composer, điền chữ, gắn ảnh, bấm Đăng, quét nhóm
├── sidepanel/                    # UI: soạn bài, nhóm, điều khiển, lịch sử
│   ├── index.html
│   ├── app.js
│   └── style.css
├── lib/
│   ├── storage.js                # chrome.storage.local + IndexedDB ảnh
│   └── groups.js                 # Parse / chuẩn hóa URL nhóm
└── icons/
```

Chi tiết luồng, message protocol và schema lưu trữ: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quyền

| Quyền | Lý do |
| --- | --- |
| `storage`, `unlimitedStorage` | Nhóm, draft, hàng đợi, lịch sử, ảnh lớn |
| `sidePanel` | UI chính |
| `tabs` | Mở / điều hướng tab Facebook |
| `scripting` | Inject content script và MAIN-world hooks (Lexical, file input) |
| `alarms` | Delay giữa các nhóm (sống sót khi service worker ngủ) |
| `https://www.facebook.com/*`, `https://web.facebook.com/*` | Content script và điều hướng |

Dữ liệu chỉ nằm trên máy (Chrome storage + IndexedDB). Không có backend.

## Phát triển

Không có bundler hay test runner. Sửa file JS/CSS/HTML → reload extension tại `chrome://extensions` → F5 tab Facebook nếu content script không phản hồi.

Luồng chính khi đăng một nhóm:

1. Side panel gửi `START_QUEUE`.
2. Service worker kiểm tra tab Facebook, lọc nhóm đã đăng cùng `contentKey`, tạo hàng đợi.
3. `ensureGroupTab` mở URL nhóm, `PING` content script.
4. Content script `POST_TO_GROUP`: mở composer → gắn ảnh → điền chữ → bấm Đăng → lấy permalink.
5. Ghi lịch sử, delay ngẫu nhiên (`chrome.alarms`), sang nhóm kế.

## Giấy phép

Repo cá nhân. Dùng cho tài khoản của bạn; không phải sản phẩm chính thức của Facebook.
