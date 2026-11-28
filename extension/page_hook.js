(() => {
  if (window.__idmlitePageHookLoaded) return;
  window.__idmlitePageHookLoaded = true;

  const rawFetch = typeof window.fetch === 'function' ? window.fetch : null;
  const emittedUrls = new Map();
  const probedUrls = new Set();
  let lastGlobalScanAt = 0;

  function classifyStreamUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) return null;

    let resolved;
    try {
      resolved = new URL(trimmed, window.location.href).href;
    } catch {
      return null;
    }

    if (!/^https?:\/\//i.test(resolved)) return null;
    const lower = resolved.toLowerCase();
    if (
      lower.includes('googlevideo.com/videoplayback') ||
      lower.includes('bytestart=') ||
      /[?&]range=\d+-\d+/i.test(lower) ||
      /[?&]sq=\d+/i.test(lower) ||
      /\/(seg|segment|chunk|frag|fragment)[_-]?\d+/i.test(lower)
    ) {
      return null;
    }

    if (/\.m3u8(\?|$|#)/i.test(lower)) return { url: resolved, type: 'hls' };
    if (/\.mpd(\?|$|#)/i.test(lower)) return { url: resolved, type: 'dash' };
    if (/\.(mp4|webm|mkv|mov|m4v)(\?|$|#)/i.test(lower)) return { url: resolved, type: 'direct' };
    return null;
  }

  function parseHlsMetadata(text) {
    if (!text || typeof text !== 'string' || !text.includes('#EXTM3U')) return null;
    const lines = text.split(/\r?\n/);
    let totalDuration = 0;
    let segmentCount = 0;
    let bestBandwidth = 0;
    let bestResolution = '';
    let bestHeight = 0;
    let bestVariantUrl = '';
    const isMaster = text.includes('#EXT-X-STREAM-INF');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        const durMatch = line.match(/^#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (durMatch) {
          const sec = parseFloat(durMatch[1]);
          if (Number.isFinite(sec) && sec > 0) {
            totalDuration += sec;
            segmentCount++;
          }
        }
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
        const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        const resStr = resMatch ? resMatch[1] : '';
        const h = resStr ? parseInt(resStr.split('x')[1], 10) : 0;
        let nextIdx = i + 1;
        while (nextIdx < lines.length && (!lines[nextIdx].trim() || lines[nextIdx].trim().startsWith('#'))) {
          nextIdx++;
        }
        const vLine = nextIdx < lines.length ? lines[nextIdx].trim() : '';
        if (h > bestHeight || (h === bestHeight && bw > bestBandwidth)) {
          bestHeight = h;
          bestBandwidth = bw;
          bestResolution = resStr;
          bestVariantUrl = vLine;
        }
      }
    }

    const duration = Math.round(totalDuration);
    const effectiveBw = bestBandwidth > 0 ? bestBandwidth : (duration > 0 ? 1500000 : 0);
    const estimatedSize = duration > 0 && effectiveBw > 0 ? Math.round((effectiveBw / 8) * duration) : 0;

    return {
      isMaster,
      duration,
      segmentCount,
      bandwidth: bestBandwidth,
      resolution: bestResolution,
      height: bestHeight,
      bestVariantUrl,
      estimatedSize,
      isEstimatedSize: estimatedSize > 0
    };
  }

  function emitUrl(rawUrl, hlsMeta = null) {
    const info = classifyStreamUrl(rawUrl);
    if (!info) return;

    const hasRichMeta = Boolean(
      hlsMeta &&
      typeof hlsMeta === 'object' &&
      (hlsMeta.duration > 0 || hlsMeta.estimatedSize > 0 || hlsMeta.bandwidth > 0 || hlsMeta.resolution)
    );
    if (emittedUrls.has(info.url)) {
      const prevRich = emittedUrls.get(info.url);
      if (!hasRichMeta || prevRich === true) return;
    }

    if (emittedUrls.size >= 200 && !emittedUrls.has(info.url)) {
      const oldest = emittedUrls.keys().next().value;
      if (oldest) emittedUrls.delete(oldest);
    }
    emittedUrls.set(info.url, hasRichMeta);

    try {
      const payload = {
        __idmliteStream: true,
        url: info.url,
        type: info.type
      };
      if (hasRichMeta) {
        if (hlsMeta.duration > 0) payload.duration = hlsMeta.duration;
        if (hlsMeta.bandwidth > 0) payload.bandwidth = hlsMeta.bandwidth;
        if (hlsMeta.resolution) payload.resolution = hlsMeta.resolution;
        if (hlsMeta.estimatedSize > 0) {
          payload.estimatedSize = hlsMeta.estimatedSize;
          payload.isEstimatedSize = Boolean(hlsMeta.isEstimatedSize);
        }
      }
      window.postMessage(payload, '*');
    } catch {
      // Ignore postMessage failures
    }
  }

  async function fetchTextInPage(targetUrl, timeoutMs = 5000) {
    if (!rawFetch) return '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await rawFetch.call(window, targetUrl, { signal: controller.signal });
      if (!res || !res.ok) return '';
      return await res.text();
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeHlsInPageWorld(m3u8Url, initialMeta = null) {
    const info = classifyStreamUrl(m3u8Url);
    if (!info || info.type !== 'hls') return;
    if (probedUrls.has(info.url)) return;
    if (probedUrls.size >= 100) {
      const oldest = probedUrls.values().next().value;
      if (oldest) probedUrls.delete(oldest);
    }
    probedUrls.add(info.url);

    let meta = initialMeta;
    if (!meta) {
      const text = await fetchTextInPage(info.url, 5000);
      meta = parseHlsMetadata(text);
    }
    if (!meta) return;

    let duration = meta.duration || 0;
    const bw = meta.bandwidth || 0;
    if (meta.isMaster && meta.bestVariantUrl && duration === 0) {
      try {
        const variantUrl = new URL(meta.bestVariantUrl, info.url).href;
        const variantText = await fetchTextInPage(variantUrl, 5000);
        const variantMeta = parseHlsMetadata(variantText);
        if (variantMeta && variantMeta.duration > 0) {
          duration = variantMeta.duration;
        }
      } catch {
        // Ignore variant probe error
      }
    }

    const effectiveBw = bw > 0 ? bw : (duration > 0 ? 1500000 : 0);
    const estimatedSize = duration > 0 && effectiveBw > 0 ? Math.round((effectiveBw / 8) * duration) : 0;
    emitUrl(info.url, {
      ...meta,
      duration,
      bandwidth: bw,
      estimatedSize,
      isEstimatedSize: estimatedSize > 0
    });
  }

  function scanPlayerGlobals() {
    try {
      const candidates = [
        window.source,
        window.source1280,
        window.source842,
        window.source720,
        window.hls && window.hls.url,
        window.player && window.player.source
      ];
      for (const item of candidates) {
        if (typeof item === 'string') {
          emitUrl(item);
        } else if (item && typeof item === 'object') {
          if (typeof item.src === 'string') emitUrl(item.src);
          if (typeof item.url === 'string') emitUrl(item.url);
          if (Array.isArray(item.sources)) {
            for (const s of item.sources) {
              if (s && typeof s.src === 'string') emitUrl(s.src);
            }
          }
        }
      }
    } catch {
      // Ignore global scan errors
    }
  }

  if (rawFetch) {
    window.fetch = function hookedFetch(input, init) {
      let info = null;
      try {
        const reqUrl = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '');
        info = classifyStreamUrl(reqUrl);
        if (info) emitUrl(reqUrl);
      } catch {
        // Ignore hook inspection error
      }
      const fetchPromise = rawFetch.call(this, input, init);
      if (info && info.type === 'hls' && emittedUrls.get(info.url) !== true && fetchPromise && typeof fetchPromise.then === 'function') {
        fetchPromise
          .then((res) => {
            if (!res || !res.ok || typeof res.clone !== 'function') return;
            return res.clone().text().then((text) => {
              const meta = parseHlsMetadata(text);
              if (!meta) return;
              if (meta.isMaster && meta.duration === 0 && meta.bestVariantUrl) {
                probeHlsInPageWorld(info.url, meta);
              } else {
                emitUrl(info.url, meta);
              }
            });
          })
          .catch(() => {});
      }
      return fetchPromise;
    };
  }

  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function hookedXhrOpen(method, url, ...rest) {
      try {
        if (typeof url === 'string') {
          emitUrl(url);
          const info = classifyStreamUrl(url);
          if (info && info.type === 'hls' && emittedUrls.get(info.url) !== true) {
            this.addEventListener(
              'load',
              () => {
                try {
                  if (this.status >= 200 && this.status < 300 && (!this.responseType || this.responseType === 'text')) {
                    const meta = parseHlsMetadata(this.responseText);
                    if (!meta) return;
                    if (meta.isMaster && meta.duration === 0 && meta.bestVariantUrl) {
                      probeHlsInPageWorld(info.url, meta);
                    } else {
                      emitUrl(info.url, meta);
                    }
                  }
                } catch {
                  // Ignore XHR inspection error
                }
              },
              { once: true }
            );
          }
        }
      } catch {
        // Ignore XHR hook inspection error
      }
      return origOpen.call(this, method, url, ...rest);
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.__idmliteProbeHls === true && typeof event.data.url === 'string') {
      probeHlsInPageWorld(event.data.url);
      return;
    }
    if (event.data.__idmliteScanGlobals === true) {
      const now = Date.now();
      if (now - lastGlobalScanAt < 5000) return;
      lastGlobalScanAt = now;
      scanPlayerGlobals();
    }
  });

  const scheduleInitialScan = () => setTimeout(scanPlayerGlobals, 1500);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInitialScan, { once: true });
  } else {
    scheduleInitialScan();
  }
})();
