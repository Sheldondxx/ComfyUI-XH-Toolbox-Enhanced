# 🎵XH-音乐卡点表（XH 家族）
#
# 干什么：给一段音乐，算出「每一刀该切在第几秒」——
#   每段都从**乐曲的小节线**上开始、下一段也收在小节线上 = 卡拍硬切。
#   它会同时给出每一段该生成多少帧（已对齐到模型帧格，如 LTX 的 8k+1）。
#
# 为什么不用它扭 etc. 而是「表」：视频帧被锁死在 8k+1（LTX）或 17k+5（H3），
#   而音乐要切在小节线上 —— **两套网格互不相容**。
#   6 小节 = 10.5495s，最近的 8k+1 是 265 帧 = 10.600s，**每段差 50ms**。
#   固定等长排下去第 10 段会漂半秒 ⇒ 必须「混合帧数」
#   （265 为主、每隔若干段插一个 257），让平均段长 = 音乐小节长，
#   误差就在 ±150ms 内来回摆、**永不累积**。这是 8 帧粒度下的数学下限。
#
# 三种「刀锋」模式（2026-10-14 加）：
#   grid      按小节线均分 —— 卡拍最稳，但每段一样长（默认）
#   structure 按内容换段 —— 自相似矩阵 novelty 找「曲子换地方了」的拐点，
#             通常是主歌↔副歌，也是画面该换的地方。**每段长短不一**
#   gap       按气口 —— 找能量掉下去的空档，切在空档中间。
#             ⚠️ 抖音「摇版」remix 母带压限极狠（实测动态范围只剩 4dB），
#             这类曲子**根本找不到气口**，节点会自动退回 structure 并在 info 里说明。
#
# 输出怎么接（两种用法，挑一种，**不要同时接**）：
#   【A】一次跑一段（老用法）
#        index 填段号 → start_sec / duration_sec / frames_now 三个标量口
#   【B】一次 Queue 跑完全部（v1.9.30）
#        接 start_sec_list / duration_sec_list / frames_now_list 三个列表口，
#        再让 🔁XH-提示词表 打开「输出全部段」吐提示词列表 ⇒ 下游自动跑 N 遍。
#        ⚠️ 列表长度按**最长的那条**算，短的会重复最后一个元素
#           （比如写了 5 段提示词、表有 21 段 ⇒ 后 16 段会重复第 5 题）。
#        ⚠️ 别在外接循环里用 —— 会 N×N。
#   frames（一行一个帧数）、info → 给人看的清单。
#
# ⛔ 零第三方依赖（2026-10-14 定制）：
#   全程只用 numpy（ComfyUI 自带）。不依赖 librosa —— 它在部分环境缺失，
#   而这件事纯 numpy 照样能干：
#     · onset envelope = 对数压缩后的正差分之和（比线性 flux 更能抑制八度错误）
#     · tempo = FFT 自相关 + 抛物线插值 + ~120BPM 先验 + 八度惩罚
#     · 相位/小节头 = 用底鼓低频能量(30~150Hz)联合搜，并加「从拍起」先验
#   实测《可惜春风不懂我伤悲》BPM 136.3093 vs librosa 135.9992（差 0.23%），
#   首小节线差 9.1ms —— 两版切点互差 ≤ 9 帧。
#
# 🔴 已知歧义：four-on-the-floor 舞曲**每拍都有底鼓**，靠低频数学上分不出
#   第 1 拍和第 3 拍。本节点靠「曲子从拍起」这条先验解决（bar_offset_beats）；
#   弱起（pickup）的曲子要手动把这个值调成 1 / 2 / 3。

import numpy as np

_WIN = 1024
_HOP = 512
_SR_REF = 44100


# ------------------------------------------------------------------ 音频整形
def _to_mono(audio):
    """ComfyUI AUDIO({'waveform': [B,C,T], 'sample_rate': int}) → (np.float32, sr)。"""
    if not isinstance(audio, dict):
        raise ValueError("[XH-音乐卡点表] audio 口必须接 LoadAudio / 🌊XH-音频 之类的音频源。")
    wf = audio.get("waveform")
    sr = int(audio.get("sample_rate") or _SR_REF)
    if wf is None:
        raise ValueError("[XH-音乐卡点表] 音频里没有波形数据。")
    if hasattr(wf, "detach"):                       # torch.Tensor
        wf = wf.detach().cpu().float().numpy()
    y = np.asarray(wf, dtype=np.float32)
    while y.ndim > 1:                               # [B,C,T] → [C,T] → [T]
        y = y[0] if y.shape[0] <= y.shape[-1] else y.mean(axis=0)
    y = np.ascontiguousarray(y.reshape(-1))
    if sr != _SR_REF and len(y) > 1:                # 零依赖重采样
        n_t = int(round(len(y) * float(_SR_REF) / float(sr)))
        if n_t > 1:
            y = np.interp(np.arange(n_t, dtype=np.float64) * (float(sr) / float(_SR_REF)),
                          np.arange(len(y), dtype=np.float64), y.astype(np.float64)).astype(np.float32)
        sr = _SR_REF
    return y, sr


# ------------------------------------------------------------------ 特征提取
def _stft_mag(y, win=_WIN, hop=_HOP):
    pad = win // 2
    yp = np.pad(y, (pad, pad), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(yp, win)[::hop]
    return np.abs(np.fft.rfft(frames * np.hanning(win), axis=1))


def _onset_flux(mag, gamma=1000.0):
    """对数压缩后再做正差分。

    ⛔ 为什么必须压缩：线性幅度 flux 里大峰值（每 2 拍一次的重鼓）会压过小峰值，
       让自相关在「两倍周期」处同样高 ⇒ 经典 octave 错误（136 BPM 被算成 68）。
    """
    L = np.log1p(gamma * np.maximum(mag, 0.0))
    flux = np.maximum(0.0, np.diff(L, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    if flux.max() > 0:
        flux = flux / flux.max()
    return flux


def _autocorr(x):
    n = len(x)
    N = 1 << int(np.ceil(np.log2(2 * n)))
    F = np.fft.rfft(x, N)
    ac = np.fft.irfft(F * np.conj(F), N)[:n]
    if ac.max() > 0:
        ac = ac / ac.max()
    return ac


# ------------------------------------------------------------------ 速度
def _pick_period(ac, fr, bpm_lo=60.0, bpm_hi=200.0):
    """挑节拍周期：局部峰 → tempo 归一化到合理区间 → 先验 × 八度惩罚排序。"""
    n = len(ac)
    lag_min = max(2, int(fr * 60.0 / bpm_hi))
    lag_max = min(n - 1, int(fr * 60.0 / bpm_lo))
    seg = ac[lag_min:lag_max + 1]
    if seg.size == 0:
        return float(max(lag_min, 1)), 60.0 * fr / float(max(lag_min, 1))

    peaks = [i + lag_min for i in range(1, len(seg) - 1)
             if seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1]]
    if not peaks:
        peaks = [int(np.argmax(seg)) + lag_min]

    prior = lambda bpm: float(np.exp(-0.5 * (np.log2(max(bpm, 1e-6) / 120.0)) ** 2))

    best = None
    for p in sorted(peaks, key=lambda x: -ac[x])[:12]:
        bpm = 60.0 * fr / float(max(p, 1))
        while bpm < bpm_lo:
            bpm *= 2.0
        while bpm > bpm_hi:
            bpm /= 2.0
        period = 60.0 * fr / bpm
        pk = min(int(round(period)), n - 1)
        # 八度惩罚：半周期处的自相关几乎同样强 ⇒ 真周期是它的一半
        half = int(round(period / 2.0))
        if 0 < half < n:
            ratio = ac[half] / max(ac[pk], 1e-9)
            penalty = 0.55 if ratio > 0.80 else (0.80 if ratio > 0.60 else 1.0)
        else:
            penalty = 1.0
        score = ac[pk] * prior(bpm) * penalty
        if best is None or score > best[0]:
            best = (score, float(period), float(bpm))
    return best[1], best[2]


# ------------------------------------------------------------------ 小节线
def _find_downbeats(low, P, bar_offset_beats=0, search_step=0.02, refine=4):
    """定开头第一个小节线在哪：在「一个小节内」细搜，评分用底鼓低频能量。

    返回 (小节线帧数组, 起点帧位置, 四个候选分数的诊断表)
    """
    n = len(low)
    if n < 8 or P <= 0:
        return np.zeros(1), 0.0, {}

    def low_at(b):
        b = int(b)
        return float(low[max(0, b - 2):b + 3].mean()) if b < n else 0.0

    # 🎯 搜索空间限制在 [bar_offset*P, bar_offset*P + P) ——
    #    即「第一个小节线落在这一拍上」。不让它扫完整个小节，
    #    否则 four-on-the-floor 曲会选到第 3 拍（实测偏整 2 拍 ≈ 0.89s）。
    def _score_at(d):
        idx = np.round(d + 4 * P * np.arange(int((n - d) / (4 * P)))).astype(int)
        idx = idx[idx < n]
        if idx.size < 4:
            return None
        return float(np.mean([low_at(int(b)) for b in idx]))

    # 🎯 正式搜索空间限制在 [bar_offset*P, bar_offset*P + P) ——
    #    即「第一个小节线落在这一拍上」。不让它扫完整个小节，
    #    否则 four-on-the-floor 曲会选到第 3 拍（实测偏整 2 拍 ≈ 0.89s）。
    lo = float(bar_offset_beats) * P
    cand = []
    d = lo
    while d < lo + P:
        s = _score_at(d)
        if s is not None:
            cand.append((s, float(d)))
        d += search_step
    if not cand:
        return np.zeros(1), 0.0, {}

    # 诊断：另外三个起拍位置各能打多少分（粗步长，够看相对高低即可）。
    # 用来告诉用户「机器有没有在犹豫」——若 1/3 拍分数咬得很紧，就该手动试 bar_offset_beats。
    diag = {}
    coarse = max(search_step * 10.0, P / 120.0)
    for o in range(4):
        best_o = None
        d = o * P
        while d < (o + 1) * P:
            s = _score_at(d)
            if s is not None and (best_o is None or s > best_o):
                best_o = s
            d += coarse
        diag[o] = best_o if best_o is not None else 0.0

    score, d0 = max(cand, key=lambda x: x[0])

    # 逐点 refine：每个小节线在 ±refine 帧内贴到真实底鼓峰值，吸收 tempo drift
    grid = np.round(d0 + 4 * P * np.arange(int((n - d0) / (4 * P)))).astype(int)
    grid = grid[grid < n]
    out = []
    for g in grid:
        a, b = max(0, int(g) - refine), min(n, int(g) + refine + 1)
        out.append(a + int(np.argmax(low[a:b])) if b > a else int(g))
    return np.array(out, dtype=float), d0, diag


# ------------------------------------------------------------------ 编排
def _greedy_frames(first, bar, nbar, n_seg, fps, mod, off):
    """混合帧数编排：让 8k+1 的离散帧数与音乐小节线长期对齐，不累积漂移。"""
    ideal_sec = nbar * bar
    ks = np.arange(1, 600)
    Fs = mod * ks + off
    F_base = int(Fs[int(np.argmin(np.abs(Fs / fps - ideal_sec)))])

    rows, prev = [], None
    for i in range(max(1, int(n_seg))):
        if i == 0:
            start = int(round(first * fps))
            F = F_base
        else:
            cands = [F_base - mod, F_base, F_base + mod, F_base + 2 * mod]
            target = (first + i * nbar * bar) * fps
            F = int(min(cands, key=lambda c: abs((prev + c) - target)))
            start = prev + F
        rows.append((start, F))
        prev = start
    return rows, ideal_sec, F_base


# ------------------------------------------------- 模式②：结构边界（自相似 + novelty）
def _mel_fb(sr, n_bands=36, fmin=80.0, fmax=8000.0):
    freqs = np.fft.rfftfreq(_WIN, 1.0 / float(sr))
    hz = fmin + (fmax - fmin) * (np.arange(n_bands + 2) / float(n_bands + 1)) ** 1.6  # 近似 mel 分布
    fb = np.zeros((len(freqs), n_bands), dtype=np.float32)
    for b in range(n_bands):
        l, c, r = hz[b], hz[b + 1], hz[b + 2]
        if c <= l:
            continue
        up = (freqs >= l) & (freqs <= c)
        dn = (freqs >= c) & (freqs <= r)
        if b == 0:
            up = freqs <= c
        fb[up, b] = (freqs[up] - l) / max(c - l, 1e-9)
        fb[dn, b] = (r - freqs[dn]) / max(r - c, 1e-9)
    s = fb.sum(axis=0)
    if s.max() > 0:
        fb = fb / np.maximum(s, 1e-9)
    return fb


def _features(y, fps_feat=10.0):
    """对数 mel 特征 → 池化到约 fps_feat 帧/秒，再做半波差分（突出"换了段落"）。"""
    mag = _stft_mag(y)
    fb = _mel_fb(_SR_REF)
    S = np.log1p(1000.0 * np.maximum(mag @ fb, 0.0))
    step = max(1, int(round((_SR_REF / float(_HOP)) / fps_feat)))
    n = len(S) // step
    if n < 8:
        return None, step
    S = S[:n * step].reshape(n, step, -1).mean(axis=1)
    S = S - S.mean(axis=0, keepdims=True)
    return S.astype(np.float32), step


def _self_sim(S):
    norm = np.linalg.norm(S, axis=1, keepdims=True)
    safe = np.maximum(norm, 1e-9)
    return (S @ S.T) / (safe @ safe.T)


def _novelty(R, L=16):
    """Foote novelty：以 k 为中心，四象限 (+,-,-,+) 加权的棋盘核相关。

    🔴 为什么必须用积分图：朴素做法对每个 k 都要遍历 L² 个点，167 秒的曲子
       要 n≈1800 次 × 1024 点；积分图把每个区块求和压到 O(1)，整体 O(n)。
    """
    n = R.shape[0]
    if n < 2 * L + 3:
        return np.zeros(n)
    I = np.zeros((n + 1, n + 1), dtype=np.float64)
    I[1:, 1:] = np.cumsum(np.cumsum(R.astype(np.float64), axis=0), axis=1)

    def blk(r0, r1, c0, c1):
        r1 = min(r1, n)
        c1 = min(c1, n)
        return I[r1, c1] - I[r0, c1] - I[r1, c0] + I[r0, c0]

    nov = np.zeros(n, dtype=np.float64)
    for k in range(L, n - L - 1):
        A = blk(k - L, k, k - L, k)
        B = blk(k + 1, k + L + 1, k - L, k)
        C = blk(k - L, k, k + 1, k + L + 1)
        D = blk(k + 1, k + L + 1, k + 1, k + L + 1)
        nov[k] = A + D - B - C
    m = nov.max()
    if m > 0:
        nov = nov / m
    # 轻量平滑，避免抖动出的假峰
    w = np.hanning(max(3, L // 2))
    w = w / w.sum()
    nov = np.convolve(nov, w, mode="same")
    return nov


def _pick_peaks(nov, n_max, gap_min):
    """贪心取最强的若干峰，并保证彼此间隔 ≥ gap_min（帧）。"""
    order = np.argsort(-nov)
    out = []
    for k in order:
        k = int(k)
        if nov[k] <= 0:
            break
        if all(abs(k - j) >= gap_min for j in out):
            out.append(k)
        if len(out) >= n_max:
            break
    return sorted(out)


def _cues_structure(y, total, seg_scale, min_seg, n_max):
    """返回 (切点秒列表, 说明文字)。

    🔴 seg_scale 是「结构检测的尺度」——由「最短一段 / 最长一段」推出来，
       **不再读 target_sec**。之前用它，导致 structure 模式下「目标每段秒」表面没用、
       实则偷偷决定检测核宽（用户 2026-10-14 指出这属于误导，已解耦）。
    """
    S, step = _features(y)
    fps_feat = (_SR_REF / float(_HOP)) / float(step)
    if S is None:
        return None, "音频太短，算不出结构。"
    R = _self_sim(S)
    L = max(8, int(round(fps_feat * max(seg_scale, 4.0) * 0.5)))      # 核宽 ≈ 半个检测尺度
    nov = _novelty(R, L=L)
    peaks = _pick_peaks(nov, n_max=n_max, gap_min=int(round(fps_feat * min_seg)))
    if not peaks:
        return None, "没有检出明显的结构拐点。"
    cuts = [0.0] + [float(p) / fps_feat for p in peaks]
    cuts = [c for c in cuts if c < total]
    note = "结构边界：自相似矩阵 novelty，检出 %d 个拐点（核宽 %.1fs，由「最短/最长一段」推得）" % (len(cuts) - 1, L / fps_feat)
    return cuts, note


# ------------------------------------------------- 模式③：气口（能量空档）
def _rms_db(y):
    win, hop = 2048, 512
    if len(y) < win:
        return None, 0.0
    frames = np.lib.stride_tricks.sliding_window_view(y, win)[::hop]
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    return 20.0 * np.log10(rms + 1e-9), (_SR_REF / float(hop))


def _cues_gaps(y, total, min_seg, n_max, min_gap=0.25):
    """找「相对周围安静」的空档，切在空档中间。

    🔴 为什么用「相对滚动峰值」而不是绝对阈值：抖音「摇版」remix 整首被压限到贴天花板，
       绝对阈值下全曲一个空档都没有（实测《可惜春风不懂我伤悲》只剩 4dB 动态范围）。
       先看最响时刻往下掉多少 dB（掉 ≥ drop dB 才算安静），从 18dB 逐级放宽到 8dB。
    """
    db, fr = _rms_db(y)
    if db is None:
        return None, "音频太短。"
    win = max(3, int(round(fr * 2.0)))
    roll_max = np.maximum.reduceat(db, np.arange(0, len(db), win)) if len(db) >= win else np.array([db.max()])
    nearest = np.interp(np.arange(len(db)),
                        np.arange(len(roll_max)) * win + win / 2.0, roll_max)

    for drop in (18.0, 14.0, 10.0, 8.0):
        quiet = db < (nearest - drop)
        runs, i = [], 0
        while i < len(quiet):
            if quiet[i]:
                j = i
                while j < len(quiet) and quiet[j]:
                    j += 1
                if (j - i) / fr >= min_gap:
                    runs.append(((i + j) / 2.0 / fr, (j - i) / fr))
                i = j
            else:
                i += 1
        if not runs:
            continue
        # 过滤掉彼此太近的，保证最短段长
        picked, last = [], -1e9
        for t, _du in runs:
            if t - last >= min_seg:
                picked.append(t)
                last = t
            if len(picked) >= n_max:
                break
        if picked:
            cuts = [0.0] + [float(t) for t in picked if t < total]
            return cuts, "气口：相对峰值降 %.0fdB，检出 %d 个空档（≥%.2fs）" % (drop, len(cuts) - 1, min_gap)
    return None, ("气口：把门槛一路放宽到 -8dB 都没找到 ≥%.2fs 的空档 —— "
                  "这首歌大概率被母带压限了（动态范围极小），已自动改用结构边界。" % min_gap)


# ------------------------------------------------- 通用：切点 → 合法帧数
def _snap_to_grid(times, grid_times, tol):
    """把每个切点吸到最近的乐句线（超出容差就保留原样）。返回 (结果, 吸附个数)。"""
    if grid_times is None or len(grid_times) == 0:
        return list(times), 0
    g = np.asarray(grid_times, dtype=np.float64)
    hit = 0
    out = []
    for t in times:
        k = int(np.argmin(np.abs(g - t)))
        if abs(float(g[k]) - t) <= tol:
            out.append(float(g[k]))
            hit += 1
        else:
            out.append(float(t))
    return out, hit


def _cuts_cap(cuts, grid_times, max_span, min_piece=0.0):
    """把超过 max_span 的长段再补几刀（落在最近的小节线上）。

    🔴 为什么必须有这道闸：模型单次有上限（LTX ≈ 20 秒），而 content 模式找出来的
       段落长度完全由音乐决定 —— 实测这首会出超长段，硬跑必崩。
    🔴 min_piece：补刀后两边都不能比它还短，否则宁可让这一段略微超限也不硬切。
    """
    if not cuts or max_span <= 0:
        return cuts
    g = np.asarray(sorted(set(grid_times)), dtype=np.float64) if grid_times is not None and len(grid_times) else None
    out = sorted(set([float(c) for c in cuts]))
    changed = True
    guard = 0
    while changed and guard < 64:
        changed, guard = False, guard + 1
        for i in range(len(out) - 1):
            a, b = out[i], out[i + 1]
            span = b - a
            if span <= max_span:
                continue
            mid = 0.5 * (a + b)
            if g is not None and len(g):
                cand = g[(g > a + 0.5) & (g < b - 0.5)]
                cand = [c for c in cand if (c - a) >= min_piece and (b - c) >= min_piece]
                ins = float(cand[int(np.argmin([abs(c - mid) for c in cand]))]) if len(cand) else None
                if ins is None and (span / 2.0) >= min_piece:
                    ins = mid
            else:
                ins = mid if (span / 2.0) >= min_piece else None
            if ins is None:                       # 两边怎么切都太碎 → 这一段就认了
                continue
            out.append(ins)
            out = sorted(set(out))
            changed = True
            break
    return out


def _frames_from_cuts(cuts, fps, mod, off):
    """逐段把「理想切点」压到合法的 mk+off 帧数上。

    🔴 关键：每段都朝着**下一个理想切点**去凑（不是各自独立四舍五入）——
       否则每段 ±4 帧的误差会一路累积，第 10 段就漂出半秒（旧版的毛病）。
    """
    ks = np.arange(1, 4096)
    legal = mod * ks + off
    rows = []
    start = int(round(float(cuts[0]) * fps))
    for i in range(len(cuts) - 1):
        target = float(cuts[i + 1]) * fps
        delta = target - start
        F = int(legal[int(np.argmin(np.abs(legal - delta)))])
        rows.append((start, max(F, int(mod + off))))
        start = start + F
    return rows


class XHBeatCueTable:
    """给音乐，算出每一段的切点秒数与帧数。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO", {"tooltip": (
                "【🎵 音频】接 LoadAudio / 🌊XH-音频 之类的音频源（整首曲子都进来，别裁）。\n"
                "立体声会自动混成单声道，采样率自动统一到 44100。\n"
                "| English: audio to analyze; stereo is down-mixed, sr resampled to 44100."
            )}),
            "target_sec": ("FLOAT", {"default": 10.28, "min": 1.0, "max": 600.0, "step": 0.01,
                "tooltip": (
                "【⏱ 参考段长 —— 只对 ① 均分模式有效】\n"
                "· 切点来源 = ① 按小节线均分：由它决定每段取几小节（填 10.28 → 挑总长最接近的整小节数）。\n"
                "· 切点来源 = ② 内容换段 / ③ 气口：**这个参数完全不参与**，段长只由「最短一段 / 最长一段」决定。\n"
                "⚠️ 唯一残留影响：当「最长一段」填 0（自动）时，自动上限 = 本值 × 1.8。\n"
                "   （你把「最长一段」手填成 16 之后，连这点影响也没有了。）\n"
                "| English: used ONLY in mode ① (even bars). Modes ②/③ ignore it entirely;\n"
                "  it only feeds the auto ceiling when 「longest segment」 is left at 0."
            )}),
            "fps": ("FLOAT", {"default": 25.0, "min": 1.0, "max": 240.0, "step": 0.1,
                "tooltip": (
                "【🎞 帧率】跟你工作流里 CreateVideo / 条件节点的帧率保持一致。\n"
                "| English: must match the fps used downstream."
            )}),
            "frame_mod": ("INT", {"default": 8, "min": 2, "max": 64, "step": 1,
                "tooltip": (
                "【🔢 帧格模数】模型的时间格。LTX / LTX-2.5 = 8（帧数 8k+1）；H3 = 17。\n"
                "改模型时连下面那个「帧格偏移」一起改，别只动一个。\n"
                "| English: temporal grid modulus. LTX=8, H3=17."
            )}),
            "frame_offset": ("INT", {"default": 1, "min": 0, "max": 63, "step": 1,
                "tooltip": (
                "【➕ 帧格偏移】帧数 ≡ 偏移 (mod 模数)。LTX = 1（8k+1）；H3 = 5（17k+5）。\n"
                "| English: frame count ≡ offset (mod modulus). LTX=1, H3=5."
            )}),
            "bars_per_seg": ("INT", {"default": 0, "min": 0, "max": 32, "step": 1,
                "tooltip": (
                "【📏 每段几小节】0 = 按上面的「目标每段秒」自动挑（推荐）。\n"
                "想强制「每 8 小节一切」就填 8。乐句感更强，但段长会偏离目标值。\n"
                "| English: 0 = auto pick the nearest bar count; otherwise force it."
            )}),
            "bar_offset_beats": ("INT", {"default": 0, "min": 0, "max": 3, "step": 1,
                "tooltip": (
                "【🥁 起拍位置】这首曲子从一小节的第几拍开始？绝大多数填 0。\n"
                "⚠️ 弱起（前奏先冒半小节）的曲子会整段错半小节，那时把它改成 1 / 2 / 3 试试。\n"
                "拿不准就看 info 里「四个候选」的分数：分不出胜负就是它在犹豫。\n"
                "| English: which beat of the bar the tune starts on. Usually 0."
            )}),
            "max_segments": ("INT", {"default": 16, "min": 1, "max": 512, "step": 1,
                "tooltip": (
                "【🔁 最多几段】表里最多排多少段（排到超过曲子长度会自动停）。\n"
                "🔴 这个值不是「要跑几段」——它只是表的上限；实际跑几段看你喂给下游几段。\n"
                "| English: max rows in the table, not how many segments to render."
            )}),
            "start_offset": ("FLOAT", {"default": 0.0, "min": -60.0, "max": 60.0, "step": 0.01,
                "tooltip": (
                "【↔️ 整体平移】把整张表前后挪一点（秒）。用来手动微调第一刀合不合耳朵。\n"
                "| English: shift the whole table in seconds for manual fine-tuning."
            )}),
            # ↓↓↓ v1.9.27 新增：不齐分 + 单段直出（新参数一律追加在末尾，旧存档不会串位）
            "mode": (["grid", "structure", "gap"], {"default": "grid", "tooltip": (
                "【🔪 切点来源】\n"
                "· grid 按小节线均分 —— 每一刀都在拍上，最稳，但每段差不多长。\n"
                "· structure 按内容换段 —— 找「曲子换地方了」的拐点（主歌↔副歌），\n"
                "  **每段长短不一**，适合「唱完一句停一下再起」那种换气口。\n"
                "· gap 按气口 —— 找能量掉下去的空档，切在空档中间。\n"
                "  ⚠️ 抖音「摇版」remix 被母带压到几乎没有起伏，这类歌找不到气口，\n"
                "  节点会自动退回 structure 并在 info 里说明。\n"
                "| English: where the cut points come from: even bars / song structure / energy gaps."
            )}),
            "min_seg_sec": ("FLOAT", {"default": 6.0, "min": 1.0, "max": 300.0, "step": 0.1,
                "tooltip": (
                "【📐 最短一段】② 内容换段 / ③ 气口 模式的两把主尺之一（另一把是「最长一段」）。\n"
                "设得太小会碎得没法看，一般 5~7 秒；同时它也决定结构检测的尺度（越大→越粗）。\n"
                "| English: minimum segment length — one of the two real length knobs in modes ②/③."
            )}),
            "max_seg_sec": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 600.0, "step": 0.5,
                "tooltip": (
                "【🛑 最长一段】硬上限（秒）。0 = 自动取「目标每段秒 × 1.8」（25fps 下约 460 帧）。\n"
                "🔴 超过它的段会被再补几刀，补在最近的小节线上 —— **包括最后那一段**\n"
                "   （最后那一段之前是漏网之鱼，实测出过 1000+ 帧的表，现已补上这道闸）。\n"
                "模型单次有上限：LTX 约 20 秒，8G 显存建议这里填 16 左右。\n"
                "| English: hard ceiling for any segment; longer ones get split on bar lines."
            )}),
            "snap_to_bar": (["on", "off"], {"default": "on", "tooltip": (
                "【🧲 吸附到乐句】把内容型切点往最近的小节线上拽（容差 = 三分之一小节）。\n"
                "好处是不切在半拍上；嫌它拽得太多就关掉。\n"
                "| English: pull content-driven cuts onto the nearest bar line."
            )}),
            "index": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 1,
                "tooltip": (
                "【🎯 取第几段】0 = 第 1 段。两种用法里都靠它：\n"
                "  A 标量三个口 → 吐**这一段**的数字；\n"
                "  B 列表三个口 → **从这一段开始往后给** batch_count 段。\n"
                "| English: which segment the outputs describe (or start from)."
            )}),
            # ↓↓↓ v1.9.30：列表模式批次控制（追加在末尾，老存档位序不受影响）
            "batch_count": ("INT", {"default": 0, "min": 0, "max": 512, "step": 1,
                "tooltip": (
                "【📦 列表模式一次给几段】0 = 从第 index 段起、一直给到表尾。\n"
                "🔴 只对 *_list 三个列表口生效，标量口不受它影响。\n"
                "🔴 别贪多：把 21 段一次扔给下游 = 一口气排 21 次生成，"
                "中间态全部驻留显存 ⇒ 8G 卡必 OOM。建议填 3~4，分批跑。\n"
                "用法：index=0/batch=4 跑第 0~3 段 → index=4/batch=4 跑第 4~7 段 → ……\n"
                "| English: how many rows the list outputs carry. 0 = to the end. "
                "Keep it small (3-4) unless you have VRAM to burn."
            )}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING", "FLOAT", "FLOAT", "INT",
                    "FLOAT", "FLOAT", "INT")
    RETURN_NAMES = ("durations", "frames", "count", "info", "start_sec", "duration_sec", "frames_now",
                    "start_sec_list", "duration_sec_list", "frames_now_list")

    # 🔴 三个 *_list 口（v1.9.30）：吐**全部 N 段**的值 ⇒ ComfyUI 自动把下游跑 N 遍。
    #    写法与 🔁XH-提示词表 完全一致（本机 execution.py:257 的语义）：
    #      · 下游fan-out长度 = 各输入列表里**最长**的那条
    #      · 短的那条会**重复最后一个元素**补齐（所以提示词条数少于段数时会重复最后一题）
    #    前 7 个口必须保持 False —— 否则老存档里「一次跑一段」的接线会突然跑 N 遍。
    OUTPUT_IS_LIST = (False, False, False, False, False, False, False,
                      True, True, True)
    FUNCTION = "analyze"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】给一首曲子，算出「每一刀切在第几秒」。三种刀锋，写在「切点来源」里：\n"
        "  grid 均分卡拍 —— 每一刀都压在小节线上，最稳，但每段一样长。\n"
        "  structure 内容换段 —— 自相似矩阵找「曲子换地方了」的拐点，每段长短不一。\n"
        "  gap 气口 —— 找能量空档切在当中；母带压限过的歌（动态范围只剩几 dB）找不到，\n"
        "              会自动退回 structure 并在 info 里说明，不会给你一张废表。\n"
        "【为什么不直接算】视频帧被锁死成 8k+1（LTX）/ 17k+5（H3），音乐要落在小节线上，"
        "两套网格天生对不齐。做法是逐段朝**下一个理想切点**去凑帧数，误差 ±150ms 来回摆、**永不累积**。\n"
        "【输出 · 两种用法挑一种，别同时接】\n"
        "  A｜一次跑一段：index 填段号，用 start_sec / duration_sec / frames_now 三个标量口。\n"
        "  B｜一次 Queue 跑完整首：接 start_sec_list / duration_sec_list / frames_now_list，\n"
        "     并让 🔁XH-提示词表 打开「输出全部段」吐提示词列表 ⇒ 下游自动按顺序逐段跑 N 遍，\n"
        "     不用外接任何循环。两份列表靠位置对齐，所以提示词要按段号顺序写好。\n"
        "     ⚠️ 列表长度取最长的那条，短的会重复最后一个元素；⚠️ 禁止和任何循环同用（会 N×N）。\n"
        "  frames（整张帧数清单，给人看）、count（总段数）、info（分析报告）。\n"
        "【零依赖】纯 numpy，不需要 librosa。\n"
        "⚠️ 它**不是循环**：跑几段照样要你手动改 index、要点几次执行。"
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        import time
        return time.time()

    def analyze(self, audio, target_sec=10.28, fps=25.0, frame_mod=8, frame_offset=1,
                bars_per_seg=0, bar_offset_beats=0, max_segments=16, start_offset=0.0,
                mode="grid", min_seg_sec=6.0, max_seg_sec=0.0, snap_to_bar="on", index=0,
                batch_count=0):
        y, sr = _to_mono(audio)
        if len(y) < sr:
            raise ValueError("[XH-音乐卡点表] 音频太短（不到 1 秒），分析不出节拍。")

        fps = float(fps) if float(fps) > 0 else 25.0
        frame_mod = int(frame_mod) if int(frame_mod) > 0 else 8
        frame_offset = max(0, min(int(frame_offset), frame_mod - 1))

        mag = _stft_mag(y)
        fr = float(sr) / float(_HOP)
        flux = _onset_flux(mag)
        freqs = np.fft.rfftfreq(_WIN, 1.0 / float(sr))
        low = mag[:, (freqs >= 30.0) & (freqs <= 150.0)].mean(axis=1)

        ac = _autocorr(flux - flux.mean())
        P, bpm = _pick_period(ac, fr)

        db_idx, d0, diag = _find_downbeats(low, P, bar_offset_beats)
        db = db_idx / fr
        if len(db) >= 2:
            slope, intercept = np.polyfit(np.arange(len(db)), db, 1)
            bar, first = float(slope), float(intercept)
        else:
            bar, first = 4.0 * P / fr, float(db[0]) / fr if len(db) else 0.0

        first += float(start_offset)
        nbar = int(bars_per_seg) if int(bars_per_seg) > 0 else int(max(1, round(float(target_sec) / max(bar, 1e-6))))

        total = float(len(y)) / float(sr)
        n_max = max(1, int(max_segments))
        min_seg = max(1.0, float(min_seg_sec))

        # ---- 三种刀锋：算出「理想切点」序列 ----
        db_list = [float(v) for v in db] if len(db) else []
        max_span = float(max_seg_sec) if float(max_seg_sec) > 0 else max(float(target_sec) * 1.8, min_seg * 2.0, 4.0)
        min_piece = max(min_seg * 0.6, 2.0)
        # 结构检测尺度：只看「最短一段 / 最长一段」这两个用户真正在意的值。
        # 🔴 刻意不读 target_sec —— 它在 structure/gap 模式下不该有任何作用。
        seg_scale = max(4.0, 0.5 * (min_seg + max_span))
        note_mode = ""
        if mode in ("structure", "gap"):
            if mode == "gap":
                cuts, note_mode = _cues_gaps(y, total, min_seg, n_max)
                # 🔴 气口模式的废表判定：抖音「摇版」这种被压限到没有起伏的曲子，
                #    只能在首尾捡到两个空档 → 段长变成「0.36s + 166s」这种垃圾，必须兜住。
                if cuts is not None:
                    span = max(cuts[i + 1] - cuts[i] for i in range(len(cuts) - 1))
                    if len(cuts) < 3 or span > total * 0.5:
                        note_mode = ("⛔ 气口：只检出 %d 个空档、最长一段 %.1fs（占全曲 %.0f%%）——\n"
                                     "   这首歌被母带压限到几乎没有起伏，气口模式不可用，已自动改用结构边界。"
                                     % (max(len(cuts) - 1, 0), span, 100.0 * span / max(total, 1e-6)))
                        cuts = None
                    else:
                        cuts = _cuts_cap(cuts, db_list, max_span)
                if cuts is None:
                    cuts2, nt = _cues_structure(y, total, seg_scale, min_seg, n_max)
                    note_mode = note_mode or ""
                    note_mode = note_mode + ("  " if note_mode else "") + nt if cuts2 else note_mode
                    cuts = cuts2
            else:
                cuts, note_mode = _cues_structure(y, total, seg_scale, min_seg, n_max)
            if cuts is None:
                cuts = _cues_structure(y, total, seg_scale, min_seg, n_max)[0]
            if cuts is None:                                    # 两条路都没戏 → 退回均分
                cuts = [float(first + i * nbar * bar) for i in range(n_max + 1)]
                note_mode = "⛔ 结构与气口都没检出可用切点，已退回均分卡拍。"
            else:
                before = len(cuts)
                cuts = _cuts_cap(cuts, db_list, max_span)       # 拆掉超过模型上限的长段
                if len(cuts) > before:
                    note_mode += "  ｜%d 段超过 %.1fs 已补刀到小节线上（共加 %d 刀）" % (
                        len(cuts) - before, max_span, len(cuts) - before)
                if snap_to_bar == "on":
                    cuts, hit = _snap_to_grid(cuts, db_list, max(bar, 1e-6) / 3.0)
                    note_mode += "  ｜吸附到小节线 %d/%d 个（容差 %.3fs）" % (hit, len(cuts), bar / 3.0)
        else:
            cuts = [float(first + i * nbar * bar) for i in range(n_max + 1)]

        # ---- 收尾：排序 → 补 0 → 补曲尾 → **再拆一次** ----
        # 🔴 为什么要先补曲尾再拆：最后一段是「最后一个切点 → 曲尾」这段路，
        #    它不由任何算法管，完全听天由命 —— 1000+ 帧就是这么漏出来的。
        #    旧版在补尾之前就拆完了，等于给尾巴开了后门。
        cuts = sorted(set(float(c) for c in cuts if -0.001 <= c < total))
        if not cuts:
            cuts = [0.0]
        elif cuts[0] > max(min_piece, 2.0):
            cuts = [0.0] + cuts          # 前奏够长才单独成一段
        else:
            cuts[0] = 0.0                # 🔴 否则并入第一段 —— 否则会多出一段 9 帧的零头
        cuts = cuts + [float(total)]
        if max_span > 0:
            cuts = _cuts_cap(cuts, db_list, max_span, min_piece)

        rows = _frames_from_cuts(cuts, fps, frame_mod, frame_offset)
        rows = [r for r in rows if r[0] / fps < total]
        if not rows:
            rows = [(0, frame_mod + frame_offset)]

        ideal_sec = nbar * bar
        k_sel = max(0, min(int(index), len(rows) - 1))
        sel = (rows[k_sel][0] / fps, rows[k_sel][1] / fps, int(rows[k_sel][1]))

        # ---- 列表模式的三根线（想要「一次 Queue 跑完整首」就接这三个，不要接上面那三个）----
        #     从第 index 段起步，给 batch_count 段；batch_count=0 → 给到表尾。
        b = max(0, int(batch_count))
        win = rows[k_sel:] if b == 0 else rows[k_sel:k_sel + b]
        if not win:                       # index 已经超到表尾 → 至少吐最后一个元素，别给空列表
            win = rows[-1:]
        st_list = [float(r[0]) / fps for r in win]
        du_list = [float(r[1]) / fps for r in win]
        fr_list = [int(r[1]) for r in win]

        ideal = cuts
        durations, frames, lines = [], [], []
        max_dev = 0.0
        for i, (start, F) in enumerate(rows):
            dur = F / fps
            durations.append("%.6f" % dur)
            frames.append("%d" % F)
            want = float(ideal[i]) if i < len(ideal) else float(start) / fps
            dev = (start / fps - want) * 1000.0
            max_dev = max(max_dev, abs(dev))
            lines.append("第 %2d 段  起点 %8.3fs  帧数 %3d  段长 %.3fs  理想 %8.3fs  偏差 %+6.1fms"
                         % (i, start / fps, F, dur, want, dev))

        top = max(diag, key=lambda k: diag.get(k, -1e18)) if diag else int(bar_offset_beats)
        if diag and top != int(bar_offset_beats):
            verdict = ("⚠️ 纯低频分数是**第 %d 拍**更高（%.2f > %.2f）—— 这首歌大概率是 "
                       "four-on-the-floor（每拍都有底鼓），从声学分不出第 1 拍和第 3 拍。\n"
                       "   现在的取舍来自「曲子从拍起」这条先验。你放出来听一下第一刀合不合，"
                       "不对就把「起拍位置」改成 %d 再算一次。"
                       % (top + 1, diag[top], diag.get(int(bar_offset_beats), 0.0), top))
        else:
            verdict = "✅ 第 %d 拍分数也是最高的，起拍位置判定一致。" % (top + 1)
        diag_txt = "  ".join("第%d拍=%.2f" % (k + 1, diag.get(k, 0.0)) for k in range(4))
        head = [
            "[XH-音乐卡点表] 曲长 %.2fs   模式 = %s" % (total, mode),
            "BPM %.4f   拍间隔 %.4fs   小节长 %.5fs（4 拍/小节）" % (bpm, P / fr, bar),
            # 🔴 只有 grid 模式才谈「每段几小节」；structure/gap 下段长由内容决定，
            #    打这行只会误导（用户 2026-10-14 指出）。
            ("第一刀 %.4fs   每段 %d 小节 = %.4fs（理想）" % (first, nbar, ideal_sec)
             if mode == "grid" else
             "第一刀 %.4fs" % first),
            "🎯 %s" % note_mode,
            "最大偏差 %.1fms（%d 帧粒度下的下限，逐段朝下一个切点凑，**不累积**）" % (max_dev, frame_mod),
        ]
        if mode in ("structure", "gap") or float(max_seg_sec) > 0:
            lengths = [r[1] / fps for r in rows]
            over = max(lengths) > max_span * 1.02
            src = "手填" if float(max_seg_sec) > 0 else "自动=目标×1.8"
            head.append("段长分布：最短 %.2fs  最长 %.2fs  平均 %.2fs  ｜上限 %.2fs（%s）%s"
                        % (min(lengths), max(lengths), sum(lengths) / max(len(lengths), 1), max_span, src,
                           "  ⚠️ 有段超上限 —— 切开左右都会太碎，已放行（把「最短一段」调小它就能拆）" if over
                           else "  ✅ 全部在上限内"))
        else:
            head.append("四个起拍候选的打分：%s" % diag_txt)
            head.append(verdict)
        head += [
            "共 %d 段，覆盖到 %.2fs" % (len(rows), (rows[-1][0] + rows[-1][1]) / fps),
            "index=%d → 起始 %.3fs / 时长 %.3fs / 帧数 %d" % (int(index), sel[0], sel[1], sel[2]) if rows else "",
            ("📦 列表口本次给第 %d~%d 段（共 %d 段）%s"
             % (k_sel, k_sel + len(st_list) - 1, len(st_list),
                " ｜batch_count=0 意为给到表尾" if b == 0 else "")) if rows else "",
            "",
        ]
        info = "\n".join([h for h in head if h] + lines)
        print(info)

        return ("\n".join(durations), "\n".join(frames), int(len(rows)), info,
                float(sel[0]), float(sel[1]), int(sel[2]),
                st_list, du_list, fr_list)


NODE_CLASS_MAPPINGS = {"XHBeatCueTable": XHBeatCueTable}
NODE_DISPLAY_NAME_MAPPINGS = {"XHBeatCueTable": "🎵XH-音乐卡点表"}
