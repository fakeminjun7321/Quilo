export interface QuiloOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface Job {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | string;
  type?: string;
  model?: string;
  filename?: string | null;
  fileId?: string | null;
  error?: string | null;
  progress?: unknown[];
  downloadUrl?: string | null;
}

export class QuiloError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  body?: unknown;
}

export class Quilo {
  constructor(options?: QuiloOptions);
  account(): Promise<Record<string, unknown>>;
  features(query?: string): Promise<Array<Record<string, unknown>>>;
  jobs: {
    list(): Promise<Job[]>;
    retrieve(id: string): Promise<Job>;
    abort(id: string): Promise<Record<string, unknown>>;
    email(id: string): Promise<Record<string, unknown>>;
    wait(id: string, options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<Job>;
    download(id: string, destination: string, options?: { fileIndex?: number }): Promise<string>;
  };
  pdf: {
    estimate(file: string, options?: { mode?: "auto" | "inplace" | "retypeset"; model?: string }): Promise<Record<string, unknown>>;
    translate(files: string | string[], options?: {
      mode?: "auto" | "inplace" | "retypeset";
      model?: string;
      restoreOnly?: boolean;
      chartRedraw?: boolean;
      background?: boolean;
      notifyEmail?: boolean;
      idempotencyKey?: string;
    }): Promise<Job>;
  };
  reports: {
    create(options: {
      type: string;
      format?: "docx" | "hwpx" | "zip";
      model?: string;
      fields?: Record<string, string | number | boolean>;
      files?: Record<string, string | string[]>;
      idempotencyKey?: string;
    }): Promise<Job>;
    translateCapstone(file: string, options?: { targetLanguage?: "ko" | "en" | "ja" | "zh"; model?: string; idempotencyKey?: string }): Promise<Job>;
  };
  conversions: {
    docxToHwpx(file: string, destination: string): Promise<string>;
  };
  documents: {
    analyzePdf(file: string): Promise<Record<string, unknown>>;
    ocrImage(file: string, options?: { includeBlocks?: boolean }): Promise<Record<string, unknown>>;
    convertHwpxEquations(file: string, destination: string, options?: { mode?: "all" | "latex" | "placeholders" }): Promise<string>;
  };
  tools: {
    wordCount(text: string): Promise<Record<string, number>>;
    statistics(values: number[]): Promise<Record<string, unknown>>;
    regression(x: number[], y: number[]): Promise<Record<string, unknown>>;
    units(): Promise<Record<string, unknown>>;
    convertUnit(value: number, from: string, to: string, category: string): Promise<Record<string, unknown>>;
    convertEquation(expression: string): Promise<{ source: string; format: string; result: string }>;
    analyzeTable(file: string): Promise<Record<string, unknown>>;
    renderGraph(input: { type?: "scatter" | "line" | "bar"; x?: Array<number | string>; y: number[]; format?: "png" | "svg"; title?: string; xLabel?: string; yLabel?: string; width?: number; height?: number }, destination: string): Promise<string>;
  };
  studios: {
    vibeConfig(): Promise<Record<string, unknown>>;
    generateVibe(idea: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    refineVibe(message: string, result: Record<string, unknown>, options?: { history?: Array<Record<string, unknown>>; model?: string }): Promise<Record<string, unknown>>;
    generateVibeImage(prompt: string): Promise<Record<string, unknown>>;
    generatePhysics(topic: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    artifactModels(): Promise<Record<string, unknown>>;
    buildArtifact(prompt: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    artifacts(): Promise<Array<Record<string, unknown>>>;
    saveArtifact(input: { title: string; html: string; slug?: string; isPublic?: boolean; category?: string; overwrite?: boolean }): Promise<Record<string, unknown>>;
    artifact(id: string): Promise<Record<string, unknown>>;
    deleteArtifact(id: string): Promise<Record<string, unknown>>;
    codeModels(): Promise<Record<string, unknown>>;
    assistCode(prompt: string, options?: { code?: string; lang?: string; model?: string }): Promise<Record<string, unknown>>;
    buildCodeProject(prompt: string, options?: { files?: Array<{ path: string; content: string }>; history?: Array<Record<string, unknown>>; model?: string }): Promise<Record<string, unknown>>;
  };
  fileChat: {
    access(): Promise<Record<string, unknown>>;
    message(message: string, options?: { files?: string[]; history?: Array<Record<string, unknown>>; model?: string }): Promise<string>;
  };
  knowledge: {
    lab(): Promise<Array<Record<string, unknown>>>;
    labEntry(id: string): Promise<Record<string, unknown>>;
  };
  community: {
    posts(options?: { category?: string }): Promise<Array<Record<string, unknown>>>;
    createPost(input: { title: string; body: string; category?: string }): Promise<Record<string, unknown>>;
    comments(postId: string): Promise<Array<Record<string, unknown>>>;
    createComment(postId: string, body: string): Promise<Record<string, unknown>>;
    vote(postId: string): Promise<Record<string, unknown>>;
  };
  webhooks: {
    list(): Promise<Array<Record<string, unknown>>>;
    create(url: string, options?: { events?: Array<"job.completed" | "job.failed" | "job.cancelled">; description?: string }): Promise<Record<string, unknown>>;
    remove(id: string): Promise<Record<string, unknown>>;
    deliveries(options?: { limit?: number }): Promise<Array<Record<string, unknown>>>;
  };
  integrations: {
    status(): Promise<Record<string, unknown>>;
    byokStatus(): Promise<Record<string, unknown>>;
    dropboxLink(path: string): Promise<Record<string, unknown>>;
    googleDriveFiles(options?: { limit?: number }): Promise<Array<Record<string, unknown>>>;
    uploadGoogleDrive(file: string): Promise<Record<string, unknown>>;
    createGoogleDoc(title: string, text: string): Promise<Record<string, unknown>>;
    createNotionPage(title: string, markdown: string): Promise<Record<string, unknown>>;
  };
}
