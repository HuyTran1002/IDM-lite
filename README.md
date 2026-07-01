# IDM Lite - Trình quản lý tải xuống siêu tốc (Multi-threaded Download Manager)

**IDM Lite** (Internet Download Manager Lite) là một ứng dụng quản lý tải xuống hiệu năng cao dành cho Windows, được phát triển nhằm tối ưu hóa tốc độ tải file thông qua công nghệ tải đa luồng phân đoạn tự động (lên đến 32 luồng đồng thời). 

Ứng dụng đi kèm mô-đun tích hợp trình duyệt (Chrome Extension) giúp tự động bắt các liên kết tải xuống từ trình duyệt Chrome, Cốc Cốc, Edge... và chuyển thẳng về IDM Lite để tải với tốc độ tối đa.

*Developed by **HuyTran1002***

---

## ✨ Tính năng nổi bật

* ⚡ **Tải xuống đa luồng thông minh:** Tự động chia nhỏ tệp tin và tải song song (lên đến 32 luồng cho file lớn), tối ưu hóa băng thông mạng.
* 🌐 **Tự động bắt link (Browser Intercept):** Tích hợp sâu vào trình duyệt Chrome để chặn và bắt các tệp tải xuống tự động.
* 📦 **Hỗ trợ đầy đủ định dạng:** Cho phép tùy chỉnh danh sách đuôi file được phép bắt link (zip, rar, exe, mp4, pdf, iso...).
* 🛑 **Tạm dừng và tiếp tục:** Hỗ trợ tạm dừng và tiếp tục tải xuống bất kỳ lúc nào mà không sợ hỏng tệp tin.
* 📥 **Tự động lưu phân loại:** Tự động phân nhóm tệp tin vào các thư mục tương ứng (Video, Music, Documents, Programs...).
* 🖥️ **Khởi chạy cùng hệ thống:** Chạy ẩn dưới khay hệ thống (System Tray), sẵn sàng bắt link bất cứ khi nào bạn mở máy.

---

## 💾 Hướng dẫn cài đặt ứng dụng IDM Lite

1. Tải về file cài đặt mới nhất: **`IDMLite Setup 1.0.1.exe`** (ở phần Releases).
2. Nhấp đúp vào file cài đặt.
3. Chọn ngôn ngữ hiển thị (Tiếng Việt/Tiếng Anh).
4. Chọn thư mục cài đặt mong muốn (mặc định sẽ cài đặt vào thư mục cá nhân của người dùng để tránh đòi hỏi quyền Admin gây chậm máy).
5. Nhấn **Cài đặt** -> Ứng dụng sẽ được khởi chạy ngay lập tức và thu nhỏ dưới khay hệ thống (System Tray).

---

## 🔌 Hướng dẫn cài đặt Chrome Extension (Tích hợp trình duyệt)

Để IDM Lite tự động bắt link khi bạn bấm tải xuống trên trình duyệt Chrome, Edge hoặc Cốc Cốc, hãy làm theo các bước đơn giản sau:

### Bước 1: Tải thư mục Extension từ ứng dụng
1. Mở ứng dụng **IDM Lite** lên.
2. Bấm vào biểu tượng bánh răng **Cài đặt** (Settings) ở góc trên bên phải.
3. Chuyển sang tab **Browser Intercept** (Tích hợp trình duyệt).
4. Nhấn nút **Tải Thư Mục Extension Về Máy**.
5. Một hộp thoại sẽ hiện lên, bạn chọn nơi muốn lưu thư mục extension này (ví dụ: **Desktop** hoặc thư mục **Documents** của bạn) và nhấn **Select Folder**.
6. Thư mục có tên `idmlite-extension` sẽ được tạo và tự động mở ra.

### Bước 2: Nạp Extension vào trình duyệt Chrome
1. Mở trình duyệt Chrome lên, truy cập đường dẫn sau bằng cách gõ vào thanh địa chỉ:
   ```
   chrome://extensions/
   ```
   và nhấn **Enter**.
2. Ở góc trên cùng bên phải của trang quản lý Extension, hãy **bật công tắc "Chế độ dành cho nhà phát triển" (Developer mode)**.
3. Ở góc trên cùng bên trái, bấm nút **"Tải tiện ích đã giải nén" (Load unpacked)**.
4. Chọn thư mục `idmlite-extension` mà bạn vừa tải về ở **Bước 1** rồi bấm **Select Folder**.
5. Extension **"IDM Lite Integration Module"** sẽ xuất hiện và hoạt động ngay lập tức!

Bây giờ bạn có thể truy cập bất kỳ trang web nào, bấm vào link tải xuống (các file có đuôi trùng với cấu hình cài đặt của bạn), IDM Lite sẽ tự động bắt link và mở cửa sổ tải siêu tốc!

---

## 🛠️ Công nghệ sử dụng
* **Core:** Electron, Node.js (Main Process)
* **Frontend:** React, Vite, Lucide Icons, Custom Premium CSS
* **Extension:** Manifest V3 Chrome Extension API
* **Installer:** NSIS (Nullsoft Scriptable Install System) với cấu hình tối ưu hóa tốc độ tải và tùy chọn ngôn ngữ.
