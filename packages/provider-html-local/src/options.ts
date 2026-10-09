export type HtmlWorkers = number | "auto";
export type HtmlQuality = "draft" | "standard" | "high";
export type HtmlBrowserGpu = "auto" | "software" | "hardware";

export type HtmlExecutionOptions = import("./browser.js").BrowserOptions & {
  readonly ffprobePath?: string;
  /** Selected FFmpeg command for both source extraction and final H.264 encoding. */
  readonly ffmpegPath?: string;
  /** Parallel Chrome workers inside one render. This is separate from Provider request concurrency. */
  readonly workers?: HtmlWorkers;
  /** Upper bound for auto's browser reservation; explicit workers remain fixed. */
  readonly maxWorkers?: number;
  readonly quality?: HtmlQuality;
  /** Chrome's rasterizer, default hardware. Use software without a usable GPU. */
  readonly browserGpu?: HtmlBrowserGpu;
  readonly processTimeoutMs?: number;
  readonly initializationTimeoutMs?: number;
  readonly frameTimeoutMs?: number;
  /**
   * Chrome DevTools Protocol timeout in milliseconds. Below the engine default
   * (300_000 ms, 5 min) Puppeteer aborts slow CDP calls (notably
   * `Runtime.callFunctionOn` for `Page.captureScreenshot`) before any per-frame
   * timeout can fire. On hosts without a usable GPU, software-rendered frame 0
   * alone can exceed 3 minutes. Default 600_000 in our config so the first
   * frame gets a chance to land; can be raised further if the host is very
   * slow (each retry still costs real work).
   */
  readonly protocolTimeoutMs?: number;
  readonly maxProcessOutputBytes?: number;
  /** Artifact staging lifecycles in flight inside one render. */
  readonly artifactStagingConcurrency?: number;
  /** Bytes of completed, out-of-order PNGs retained while an MP4 waits for its next frame. */
  readonly maxPendingFrameBytes?: number;
  /** Bytes of decoded source PNGs resident in one render's reusable working set. */
  readonly maxDecodedSourceBytes?: number;
  readonly maxRenderedBytes?: number;
};
