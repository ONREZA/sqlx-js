declare global {
  namespace SqlxJsJson {
    type UserSettings = {
      theme: "light" | "dark";
      lang: string;
      notifications?: { email: boolean; push: boolean };
    };

    type PostMeta = {
      tags?: string[];
      pinned?: boolean;
      readingTimeSec?: number;
    };

    type Attachment = {
      url: string;
      kind: "image" | "video" | "file";
      sizeBytes: number;
    };
  }
}

export {};
