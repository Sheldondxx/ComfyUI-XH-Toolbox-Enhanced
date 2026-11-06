# 🪟 XH-悬浮任意窗口（原名：🎬XH-悬浮视频窗）
# 把**任意**窗口钉在最上层并缩成一个小浮窗 —— 边在 ComfyUI 里干活，边看别的窗口，不用切来切去。
#
# 🔴 2026-10-20 02:50 重定位（用户自己发现的）：
#   单纯**看视频**根本不需要这个节点 —— 浏览器自带「画中画（PiP）」更省资源
#   （GPU 合成、默认置顶、切标签页继续播）。PiP 只浮得了 <video> 元素，
#   **浮不了整个窗口**，所以本节点的价值位是：浮**文字教程 / 文档 / 另一个 ComfyUI / 任意程序**。
#   ⇒ 扫描列表从"只列 Edge/Chrome"改成"列出所有可见窗口（带进程名）"。
#
# 🔴 零依赖：只用标准库 ctypes 调 user32，**不需要 pywin32**（本机 .venv 里没装）。
# ⚠️ 只支持 Windows。非 Windows 平台节点照样能拖出来，但点按钮会返回错误。
#
# 🔴🔴 2026-10-20 02:35 修「点了没反应」的真根因（事故复盘）：
#   ① ctypes 没声明 argtypes ⇒ `HWND_TOPMOST=-1` 按 32 位 int 传，被零扩展成
#      0x00000000FFFFFFFF（非法 HWND），**SetWindowPos 每次都返回 0（失败），静默无效**。
#      实测：旧写法 ret=0、topmost=False；声明 argtypes 后 ret=1、topmost=True。
#   ② 目标窗口是**最大化**状态时，SetWindowPos 改不了尺寸（Windows 会保持最大化）
#      ⇒ 必须先 ShowWindow(SW_RESTORE) 再摆位置。
#   ③ 多屏 / 高 DPI 下按主屏算坐标会把窗口甩到别的显示器或屏幕外
#      ⇒ 改成按**鼠标所在显示器的工作区**定位，并 clamp 在里面。
#   ④ 移动后回读真实 rect 一起返回 ⇒ 前端能显示"搬到哪了"，不再靠猜。

import ctypes
from ctypes import wintypes

_ROUTES_DONE = False
_ORIG = {}          # hwnd -> {"rect": [l,t,r,b], "zoomed": bool} 记录悬浮前状态，供还原

HWND = wintypes.HWND
BOOL = wintypes.BOOL
UINT = wintypes.UINT
LONG_PTR = ctypes.c_ssize_t

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(BOOL, HWND, wintypes.LPARAM)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_SHOWWINDOW = 0x0040
SWP_NOACTIVATE = 0x0010
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002

SW_RESTORE = 9
SW_MAXIMIZE = 3

# 半透明
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TOPMOST = 0x00000008
LWA_ALPHA = 0x00000002
RDW_INVALIDATE = 0x0001
RDW_UPDATENOW = 0x0100
RDW_ERASE = 0x0004

MONITOR_DEFAULTTONEAREST = 2

# ---------- 🔴 关键：把所有 user32 函数的签名写死 ----------
#    不写 argtypes 时，指针/句柄类参数会被当成 32 位 int 传，64 位下直接失效。
user32.SetWindowPos.argtypes = [HWND, HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, UINT]
user32.SetWindowPos.restype = BOOL

user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
user32.ShowWindow.restype = BOOL

user32.IsWindowVisible.argtypes = [HWND]
user32.IsWindowVisible.restype = BOOL
user32.IsIconic.argtypes = [HWND]
user32.IsIconic.restype = BOOL
user32.IsZoomed.argtypes = [HWND]
user32.IsZoomed.restype = BOOL

user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = BOOL

user32.GetWindowTextLengthW.argtypes = [HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

user32.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD

user32.SetLayeredWindowAttributes.argtypes = [HWND, wintypes.DWORD, ctypes.c_ubyte, wintypes.DWORD]
user32.SetLayeredWindowAttributes.restype = BOOL

user32.RedrawWindow.argtypes = [HWND, ctypes.c_void_p, ctypes.c_void_p, UINT]
user32.RedrawWindow.restype = BOOL

user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int

# kernel32 同理：OpenProcess 返回的是**指针大小**的 HANDLE，不声明 restype 会被截成 32 位
kernel32.OpenProcess.argtypes = [wintypes.DWORD, BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                               wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel32.QueryFullProcessImageNameW.restype = BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = BOOL

# GetWindowLongPtrW / SetWindowLongPtrW（32 位 Python 上没有，退回 LongW）
if hasattr(user32, "GetWindowLongPtrW"):
    _get_long = user32.GetWindowLongPtrW
    _get_long.argtypes = [HWND, ctypes.c_int]
    _get_long.restype = LONG_PTR
    _set_long = user32.SetWindowLongPtrW
    _set_long.argtypes = [HWND, ctypes.c_int, LONG_PTR]
    _set_long.restype = LONG_PTR
else:
    _get_long = user32.GetWindowLongW
    _get_long.argtypes = [HWND, ctypes.c_int]
    _get_long.restype = ctypes.c_long
    _set_long = user32.SetWindowLongW
    _set_long.argtypes = [HWND, ctypes.c_int, ctypes.c_long]
    _set_long.restype = ctypes.c_long


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD)]


class WINDOWPLACEMENT(ctypes.Structure):
    """🔴 最小化窗口的 GetWindowRect 会返回一个 158×26 的小条 —— 用它当"原始尺寸"
    会把窗口还原成一条。必须读 rcNormalPosition（它才是还原后的真实矩形）。"""
    _fields_ = [("length", UINT), ("flags", UINT), ("showCmd", UINT),
                ("ptMinPosition", POINT), ("ptMaxPosition", POINT),
                ("rcNormalPosition", wintypes.RECT)]


user32.GetWindowPlacement.argtypes = [HWND, ctypes.POINTER(WINDOWPLACEMENT)]
user32.GetWindowPlacement.restype = BOOL


user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetCursorPos.restype = BOOL
user32.MonitorFromPoint.argtypes = [POINT, wintypes.DWORD]
user32.MonitorFromPoint.restype = ctypes.c_void_p
user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MONITORINFO)]
user32.GetMonitorInfoW.restype = BOOL

# 尺寸预设（前端 combo 用同一套名字，别各写一份）
# 🔴 2026-10-20 实测：Edge/Chrome 有**最小窗口宽度 ≈ 515**（设 320/400 都会被撑到 515），
#    所以预设别再写 320 那种达不到的数字，否则用户选了"小"却拿到 515 宽，以为没生效。
# ★ 2026-10-20 重定预设（用户原话："预设的那些长度那么长，宽度那么窄，这样怎么才能看视频呢"）
#   原来的 520×220 / 700×300 / 900×400 / 1100×480 全是 **2.3:1 超宽扁**，
#   高只有 220~480，看视频上下都是浪费、字幕也糊。视频是 16:9（1.78:1）⇒ 全部改成 16:9 全系列。
#   🔴 **key 故意不改**（还是 "中 700×300" 这种旧串）：老工作流的 widgets_values 存的就是这些 key，
#      改 key 会让所有老节点匹配不到选项而回退/变红。key 只当"存档 id"用，真实尺寸看右边；
#      节点上显示的尺寸文字由前端 getOptionLabel 映射成新的真实值。
SIZE_PRESETS = {
    "小 520×220": (640, 360),      # 16:9
    "中 700×300": (800, 450),      # 16:9
    "大 900×400": (1024, 576),     # 16:9
    "超大 1100×480": (1280, 720),  # 16:9 全高清
}

# 预设的真实尺寸（前端显示用；key 与真实值不一致，这是有意为之，见上面注释）
PRESET_DISPLAY = {
    "小 520×220": "小 640×360",
    "中 700×300": "中 800×450",
    "大 900×400": "大 1024×576",
    "超大 1100×480": "超大 1280×720",
}


def _get_exstyle(hwnd):
    return int(_get_long(hwnd, GWL_EXSTYLE)) & 0xFFFFFFFF


def _set_exstyle(hwnd, style):
    _set_long(hwnd, GWL_EXSTYLE, int(style))


def set_opacity(hwnd, pct):
    """整体半透明：100 = 不透明（并摘掉 layered 样式，避免残留）。"""
    try:
        pct = max(30, min(100, int(pct)))
    except Exception:                                   # noqa: BLE001
        pct = 100
    try:
        cur = _get_exstyle(hwnd)
        if pct >= 100:
            _set_exstyle(hwnd, cur & ~WS_EX_LAYERED)
        else:
            _set_exstyle(hwnd, cur | WS_EX_LAYERED)
            user32.SetLayeredWindowAttributes(wintypes.HWND(hwnd), 0,
                                              int(pct * 255 / 100), LWA_ALPHA)
        user32.RedrawWindow(wintypes.HWND(hwnd), None, None,
                            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ERASE)
        return True
    except Exception:                                   # noqa: BLE001
        return False


# Edge 与 Chrome 的主窗口是同一个类名，所以按尺寸 + 标题再过滤
BROWSER_CLASSES = ("Chrome_WidgetWin_1",)
# 🔴🔴 但**光靠类名不够**：ComfyUI 桌面版、WorkBuddy、VS Code 这些 Electron 应用
#    窗口类名也是 Chrome_WidgetWin_1（实测：Comfy Desktop 和 WorkBuddy 都被误判成浏览器）。
#    ⇒ 必须再按**进程 exe 名**过滤。
BROWSER_EXES = ("msedge.exe", "chrome.exe")

# ---------- 枚举"任意窗口"时的排除项 ----------
GW_OWNER = 4
WS_EX_TOOLWINDOW = 0x00000080
user32.GetWindow.argtypes = [HWND, UINT]
user32.GetWindow.restype = HWND

# 系统壳层 / 虚拟桌面 / 输入法 / UWP 占位窗口：可见但悬浮它没有意义
SKIP_CLASSES = (
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW",
    "DV2ControlHost", "ForegroundStaging", "ApplicationManager_ImmersiveShellWindow",
    "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
    "EdgeUiInputTopLevelWindow", "Microsoft.Windows.Shell.Run.PlacementWindow",
    "MSCTFIME UI", "IME", "Default IME", "tooltips_class32", "#32768",
)

CORNER_MAP = {
    "右上": "right_top", "左上": "left_top",
    "右下": "right_bottom", "左下": "left_bottom",
}


def _wtext(hwnd):
    n = user32.GetWindowTextLengthW(wintypes.HWND(hwnd))
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(wintypes.HWND(hwnd), buf, n + 1)
    return buf.value


def _wclass(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
    return buf.value


def _wrect(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(r))
    return [r.left, r.top, r.right, r.bottom]


def _normal_rect(hwnd):
    """窗口"非最小化状态"下的矩形（最小化时 GetWindowRect 只给 158×26 的小条，不能用）。"""
    try:
        wp = WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(WINDOWPLACEMENT)
        if user32.GetWindowPlacement(wintypes.HWND(hwnd), ctypes.byref(wp)):
            r = wp.rcNormalPosition
            return [r.left, r.top, r.right, r.bottom]
    except Exception:                                   # noqa: BLE001
        pass
    return _wrect(hwnd)


def _pid_of(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    return int(pid.value)


def _exe_of(pid):
    """取进程的 exe 文件名（小写），失败返回空串。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit("\\", 1)[-1].lower()
        return ""
    except Exception:
        return ""
    finally:
        try:
            kernel32.CloseHandle(h)
        except Exception:
            pass


def _candidate(hwnd, min_w, min_h):
    """判断这个顶层窗口值不值得出现在列表里，值得就返回信息 dict，否则 None。"""
    if not user32.IsWindowVisible(wintypes.HWND(hwnd)):
        return None
    cls = _wclass(hwnd)
    if cls in SKIP_CLASSES:
        return None
    # 有 owner 的基本都是工具/弹出子窗口（菜单、下拉、提示条），不该被悬浮
    try:
        if user32.GetWindow(wintypes.HWND(hwnd), GW_OWNER):
            return None
    except Exception:                                   # noqa: BLE001
        pass
    # 工具窗口（工具栏 / 输入法 / 悬浮小部件）一律跳过
    if _get_exstyle(hwnd) & WS_EX_TOOLWINDOW:
        return None
    title = _wtext(hwnd)
    if not title.strip():
        return None
    minimized = bool(user32.IsIconic(wintypes.HWND(hwnd)))
    # 🔴 最小化窗口的 GetWindowRect 是 158×26 的小条 ⇒ 用"还原后"的矩形来判断和显示
    l, t, r, b = _normal_rect(hwnd) if minimized else _wrect(hwnd)
    if (r - l) < min_w or (b - t) < min_h:
        return None
    pid = _pid_of(hwnd)
    return {"hwnd": int(hwnd), "title": title, "rect": [l, t, r, b],
            "zoomed": bool(user32.IsZoomed(wintypes.HWND(hwnd))),
            "minimized": minimized,
            "exe": _exe_of(pid), "class": cls}


def enum_windows(min_w=200, min_h=120, limit=80):
    """枚举**所有**可悬浮的可见顶层窗口（浏览器 / 编辑器 / 文档 / 终端……都算）。
    注意：最小化窗口也算 visible（IsWindowVisible 为 True），悬浮时会先 SW_RESTORE。
    排序：浏览器排最前（最常用的场景），其余按 Z 序（EnumWindows 本身就是从前往后）。"""
    out = []

    def _cb(hwnd, _lp):
        try:
            info = _candidate(hwnd, min_w, min_h)
            if info:
                out.append(info)
        except Exception:                               # noqa: BLE001
            pass
        return True

    user32.EnumWindows(EnumWindowsProc(_cb), 0)
    out.sort(key=lambda w: (0 if w.get("exe") in BROWSER_EXES else 1,))
    return out[:limit]


def find_browser_windows(min_w=200, min_h=120):
    """（兼容旧调用）只取浏览器窗口：类名匹配 + 进程 exe 名过滤。"""
    return [w for w in enum_windows(min_w, min_h) if w.get("exe") in BROWSER_EXES]


def _work_area_for_cursor():
    """鼠标所在显示器的工作区（已排除任务栏）。多屏/高 DPI 下比主屏坐标靠谱。"""
    pt = POINT()
    if user32.GetCursorPos(ctypes.byref(pt)):
        hmon = user32.MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)
        if hmon:
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(MONITORINFO)
            if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                return [mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom]
    return [0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)]


def _status(hwnd):
    """回读窗口真实状态（用于告诉用户"搬到哪了"）。"""
    try:
        r = _wrect(hwnd)
        return {
            "rect": r,
            "normal": _normal_rect(hwnd),
            "size": [r[2] - r[0], r[3] - r[1]],
            "topmost": bool(_get_exstyle(hwnd) & WS_EX_TOPMOST),
            "zoomed": bool(user32.IsZoomed(wintypes.HWND(hwnd))),
            "minimized": bool(user32.IsIconic(wintypes.HWND(hwnd))),
            "visible": bool(user32.IsWindowVisible(wintypes.HWND(hwnd))),
        }
    except Exception:                                   # noqa: BLE001
        return {}


def list_windows(limit=80):
    """给前端「🔍 扫描」用 —— 列出当前**所有**能悬浮的窗口（浏览器排最前）。
    每项带 exe 进程名，前端下拉显示成「edge · 标题」，用户一眼能认出是哪个程序。"""
    wins = enum_windows(limit=limit)
    wa = _work_area_for_cursor()
    return {
        "ok": True,
        "work_area": wa,
        "windows": [
            {
                "hwnd": w["hwnd"],
                "title": (w.get("title") or "")[:60],
                "exe": w.get("exe") or "",
                "w": w["rect"][2] - w["rect"][0],
                "h": w["rect"][3] - w["rect"][1],
                "zoomed": w.get("zoomed", False),
                "minimized": w.get("minimized", False),
            }
            for w in wins
        ],
    }


def float_window(width=480, height=270, corner="right_top", title_kw="", hwnd=None, opacity=100):
    """把**任意**窗口钉在最上层并缩放到指定大小/位置（可指定 hwnd，可半透明）。"""
    wins = enum_windows()
    if hwnd:
        try:
            hwnd = int(hwnd)
        except Exception:                               # noqa: BLE001
            hwnd = None
    if hwnd:
        before = _status(hwnd)
        picked = [w for w in wins if w["hwnd"] == hwnd]
        if not picked:
            # 扫描之后窗口可能被最小化/改过 ⇒ 枚举不到也直接认这个句柄
            picked = [{"hwnd": hwnd, "title": _wtext(hwnd),
                       "rect": before.get("rect") or _wrect(hwnd),
                       "zoomed": before.get("zoomed", False)}]
        wins = picked
    elif title_kw:
        wins = [w for w in wins if title_kw.lower() in (w.get("title") or "").lower()]
    if not wins:
        return {"ok": False, "error": "没找到可悬浮的窗口 —— 先把要浮的窗口打开（最小化也行，会自动还原）"}

    w = wins[0]
    hwnd = w["hwnd"]
    pre = _status(hwnd)
    # 只记第一次，避免重复悬浮时把"浮窗尺寸"当成原始尺寸
    # 🔴 必须记 **normal** 矩形：最小化窗口的 GetWindowRect 是 158×26，记它还原就成一条了
    _ORIG.setdefault(hwnd, {"rect": pre.get("normal") or w["rect"],
                            "zoomed": bool(pre.get("zoomed")),
                            "minimized": bool(pre.get("minimized")),
                            "corner": corner})          # ★ 记角落，用于多窗口错开
    _ORIG[hwnd]["corner"] = corner                      # 重复悬浮同一窗口时允许换角落

    wa = _work_area_for_cursor()
    m = 12
    width = max(200, min(int(width), wa[2] - wa[0] - 2 * m))
    height = max(120, min(int(height), wa[3] - wa[1] - 2 * m))
    x = wa[2] - width - m if "right" in corner else wa[0] + m
    y = wa[1] + m if "top" in corner else wa[3] - height - m

    # ★ 2026-10-20 多窗口同时悬浮：同一个角落的第 N 个窗口错开一层（级联 26px），
    #   否则全都叠在右上角，后面的把前面的完全盖住 = 等于只浮了一个。
    off = _slot_offset(corner, hwnd) * 26
    if "right" in corner:
        x -= off
    else:
        x += off
    if "top" in corner:
        y += off
    else:
        y -= off
    x = max(wa[0] + 2, min(x, wa[2] - width - 2))
    y = max(wa[1] + 2, min(y, wa[3] - height - 2))

    # 🔴 最大化/最小化的窗口必须先还原，否则 SetWindowPos 改不动尺寸
    try:
        if user32.IsZoomed(wintypes.HWND(hwnd)) or user32.IsIconic(wintypes.HWND(hwnd)):
            user32.ShowWindow(wintypes.HWND(hwnd), SW_RESTORE)
    except Exception:                                   # noqa: BLE001
        pass

    ctypes.set_last_error(0)
    ok = user32.SetWindowPos(wintypes.HWND(hwnd), wintypes.HWND(HWND_TOPMOST),
                             int(x), int(y), int(width), int(height),
                             SWP_SHOWWINDOW | SWP_NOACTIVATE)
    err = ctypes.get_last_error()
    set_opacity(hwnd, opacity)

    after = _status(hwnd)
    res = {
        "ok": bool(ok),
        "hwnd": hwnd,
        "title": w.get("title", ""),
        "requested": [int(x), int(y), int(width), int(height)],
        "actual": after.get("rect"),
        "size": after.get("size"),
        "topmost": after.get("topmost"),
        "zoomed": after.get("zoomed"),
        "work_area": wa,
    }
    if not ok:
        res["error"] = f"SetWindowPos 失败（WinError {err}）"
    return res


def _slot_offset(corner, hwnd=None):
    """同一角落里，排在第几个（用于级联错开）。自己不计数。"""
    n = 0
    for h, info in _ORIG.items():
        if info.get("corner") == corner and h != hwnd:
            n += 1
    return min(n, 6)        # 最多错开 6 层，再多就重回原点（免得飘出屏幕）


def list_floating():
    """当前**正在悬浮**的窗口清单（前端多窗口管理列表用）。"""
    out = []
    for hwnd, info in list(_ORIG.items()):
        try:
            st = _status(hwnd)
            if not st.get("exists", True):
                continue
            out.append({
                "hwnd": hwnd,
                "title": _wtext(hwnd) or "",
                "exe": _exe_of(_pid_of(hwnd)),
                "size": st.get("size"),
                "pos": [st.get("rect", [0, 0, 0, 0])[0], st.get("rect", [0, 0, 0, 0])[1]],
                "corner": info.get("corner", ""),
                "topmost": st.get("topmost"),
                "was_minimized": bool(info.get("minimized")),
            })
        except Exception:                                # noqa: BLE001
            continue
    return {"ok": True, "count": len(out), "floating": out}


def restore_window(hwnd=None):
    """还原窗口。
    🔴 2026-10-20：传 hwnd ⇒ **只还原这一个**（多窗口各自独立控制）；
       不传 ⇒ 全部还原（保留旧行为）。
    原来不管点哪个节点的还原都一次清光 —— 多窗口场景下等于没法单独控制。
    """
    if not _ORIG:
        return {"ok": False, "error": "没有记录到被悬浮的窗口（可能已经还原过）"}
    if hwnd is not None:
        try:
            hwnd = int(hwnd)
        except Exception:                                # noqa: BLE001
            return {"ok": False, "error": "hwnd 不是数字"}
        if hwnd not in _ORIG:
            return {"ok": False, "error": "这个窗口不在悬浮列表里（可能已经还原过或已被关闭）"}
        targets = [(hwnd, _ORIG.pop(hwnd))]
    else:
        targets = list(_ORIG.items())
        _ORIG.clear()
    n = 0
    was_min = []            # 原本是最小化的窗口：还原后**不再**缩回去（否则用户以为没还原）
    for hwnd, info in targets:
        try:
            set_opacity(hwnd, 100)                  # 先摘半透明，否则还原后窗口是灰的
            l, t, r, b = info["rect"]
            if user32.IsIconic(wintypes.HWND(hwnd)) or user32.IsZoomed(wintypes.HWND(hwnd)):
                user32.ShowWindow(wintypes.HWND(hwnd), SW_RESTORE)
            user32.SetWindowPos(wintypes.HWND(hwnd), wintypes.HWND(HWND_NOTOPMOST),
                                int(l), int(t), int(r - l), int(b - t),
                                SWP_SHOWWINDOW | SWP_NOACTIVATE)
            if info.get("zoomed"):
                user32.ShowWindow(wintypes.HWND(hwnd), SW_MAXIMIZE)
            elif info.get("minimized"):
                was_min.append(hwnd)
            n += 1
        except Exception:                           # noqa: BLE001
            pass
    # 🔴 别在这里再 _ORIG.clear()：单独还原时上面已经 pop 掉这一个，
    #    再 clear 会把**其它还在悬浮的窗口**的记录一起抹掉 ⇒ 它们再也还原不回去了。
    return {"ok": True, "count": n, "was_minimized": was_min,
            "restored_hwnd": hwnd if len(targets) == 1 else None,
            "still_floating": len(_ORIG)}


def register_routes():
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes

        @routes.post("/xh/floatwindow/apply")
        async def _xh_floatwindow_apply(request):
            try:
                data = await request.json()
            except Exception:
                data = {}

            action = (data.get("action") or "float").strip()
            if action == "restore":
                try:
                    # ★ 带 hwnd = 只还原这一个（多窗口独立控制）；不带 = 全部还原
                    return web.json_response(restore_window(data.get("hwnd")))
                except Exception as e:                  # noqa: BLE001
                    return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})

            # 扫描窗口列表（前端「🔍 扫描」按钮）
            if action == "list":
                try:
                    return web.json_response(list_windows())
                except Exception as e:                  # noqa: BLE001
                    return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})

            # ★ 当前正在悬浮的窗口清单（多窗口管理列表；刷新页面后也能把已浮的找回来）
            if action == "floating":
                try:
                    return web.json_response(list_floating())
                except Exception as e:                  # noqa: BLE001
                    return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})

            # 诊断：只读，不碰任何窗口
            if action == "status":
                try:
                    return web.json_response({"ok": True, "window": _status(int(data.get("hwnd") or 0))})
                except Exception as e:                  # noqa: BLE001
                    return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})

            # 尺寸：优先用预设（小/中/大），没有预设再用自定义数值
            preset = str(data.get("size_preset") or "").strip()
            if preset in SIZE_PRESETS:
                w, h = SIZE_PRESETS[preset]
            else:
                try:
                    w = max(200, min(int(data.get("width") or 480), 2000))
                    h = max(120, min(int(data.get("height") or 270), 2000))
                except Exception:                       # noqa: BLE001
                    w, h = 480, 270

            corner = str(data.get("corner") or "right_top").strip()
            corner = CORNER_MAP.get(corner, corner)
            title_kw = str(data.get("title_keyword") or "").strip()

            hwnd = data.get("hwnd")
            try:
                opacity = int(data.get("opacity") or 100)
            except Exception:                           # noqa: BLE001
                opacity = 100

            try:
                return web.json_response(float_window(w, h, corner, title_kw, hwnd, opacity))
            except Exception as e:                      # noqa: BLE001
                return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"})

        _ROUTES_DONE = True
    except Exception as e:                              # noqa: BLE001
        print(f"[XH-FloatWindow] 路由注册失败: {e}")


register_routes()


class XHFloatVideo:
    """🪟XH-悬浮任意窗口：把任意程序窗口钉在画布上层、缩成小浮窗（纯 UI，不参与计算）。
    ⚠️ class type 保持 XHFloatVideo 不变 —— 老工作流里的这个节点才不会找不到。"""

    DESCRIPTION = (
        "【干什么】把**任意**程序窗口缩成小浮窗、钉在最上层 —— 边在 ComfyUI 里干活，边看别的窗口。\n"
        "【怎么用】\n"
        "  ① 点「🔍 扫描」→ 下拉框列出当前**所有**打开的窗口（带程序名，不用猜）\n"
        "  ② 挑一个窗口 → ③ 点「🪟 悬浮」→ 缩到**鼠标所在那块屏幕**的角落\n"
        "  ④ 想再浮一个？回到 ① 继续，**可以同时浮多个窗口**\n"
        "【多窗口：每个窗口单独控制】\n"
        "  · 同一角落的第 2、3 个窗口会**自动级联错开 26px**，不会全叠在一起互相盖住\n"
        "  · 节点里的「已悬浮」列表：**每个窗口一行**，\n"
        "      🪟 = 只把这个窗口按当前设置重摆一次（改尺寸/角落/透明度后再点它）\n"
        "      ↺ = **只还原这一个**，其它浮窗完全不受影响\n"
        "  · 工具条上的「↺ 全还原」才是把所有浮窗一起还原\n"
        "  · 刷新页面 / 重启 ComfyUI 后，已浮的窗口会自动列回列表，仍然能单独控制\n"
        "【💡 只是看视频？别用这个】浏览器自带「画中画」更好用：B 站等播放器上的「□↘」按钮，\n"
        "  一按就浮出来，走 GPU 合成不吃资源、默认置顶、切标签页也继续播。\n"
        "  本节点存在的意义是：画中画**只浮得了视频**，浮不了整个窗口。\n"
        "【适合浮什么】文字教程 / GitHub 文档 / 另一个 ComfyUI 实例对照 / 终端 / 笔记 / 聊天窗口。\n"
        "【参数】尺寸（小/中/大/超大，或自定义数值）· 停靠角落 · 不透明度（压住画布时可调淡一点）。\n"
        "  这些参数是**当前设置**，对列表里的每个窗口分别生效（谁点 🪟 谁按新设置重摆）。\n"
        "  ⚠️ 每个窗口有 Windows 强制最小尺寸（浏览器约 520 宽），设更小也只会到下限。\n"
        "【输出】无 —— 纯界面工具，删掉不影响流程。\n"
        "⚠️ 只支持 Windows；目标窗口最小化也能浮（会自动还原）。某些程序不支持半透明，会自动忽略。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "size_preset": (
                    list(SIZE_PRESETS.keys()) + ["自定义（用下面两个数值）"],
                    {"default": "中 700×300"},
                ),
                "corner": (["右上", "左上", "右下", "左下"], {"default": "右上"}),
                "opacity": ("INT", {"default": 100, "min": 30, "max": 100, "step": 5}),
            },
            # width / height / title_keyword 只是为了**老工作流不报错**，前端已隐藏，别再手填
            "optional": {
                "width": ("INT", {"default": 480, "min": 200, "max": 2000, "step": 10}),
                "height": ("INT", {"default": 270, "min": 120, "max": 2000, "step": 10}),
                "title_keyword": (
                    "STRING",
                    {"default": "", "multiline": False,
                     "placeholder": "可选：只在标题含这个词的窗口里找"},
                ),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "🔁XH/工具"
    OUTPUT_NODE = True

    def noop(self, **kwargs):
        return ()


NODE_CLASS_MAPPINGS = {"XHFloatVideo": XHFloatVideo}
# 🔴 key 必须是 XHFloatVideo（老工作流按 class type 存），只改显示名
NODE_DISPLAY_NAME_MAPPINGS = {"XHFloatVideo": "🪟XH-悬浮任意窗口"}
