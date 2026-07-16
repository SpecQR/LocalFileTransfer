import { useEffect, useMemo } from "react";

export type SupportedLocale = "en" | "ja";

export interface MessageCatalog {
   appName: string;
   openingRoom: string;
   desktopRoomUnavailable: string;
   missingRoomId: string;
   connected: string;
   openingFailed: string;
   refreshFailed: string;
   reconnecting: string;
   roomEnded: string;
   addingFiles: string;
   ready: string;
   addFilesFailed: string;
   creatingRoom: string;
   resetFailed: string;
   preparingFile: (current: number, total: number) => string;
   uploadingFile: (current: number, total: number) => string;
   uploadPaused: string;
   pausing: string;
   filesNeedRetry: (count: number) => string;
   retryExplanation: string;
   uploadComplete: string;
   cancelFailed: string;
   refreshRoom: string;
   chooseFiles: string;
   pause: string;
   resume: string;
   uploadCount: (count: number) => string;
   selectedFiles: string;
   removeSelectedFile: (name: string) => string;
   downloadAll: (count: number) => string;
   downloadAllName: string;
   addFiles: string;
   copyRoomLink: string;
   copyLink: string;
   resetRoom: string;
   sharedText: string;
   sharedTextUnread: string;
   sharedTextTitle: string;
   sharedTextAreaLabel: string;
   sharedTextPlaceholder: string;
   sharedTextLoading: string;
   sharedTextUnavailable: string;
   sharedTextUpToDate: string;
   sharedTextUnsaved: string;
   sharedTextShared: string;
   sharedTextSaving: string;
   sharedTextCopied: string;
   sharedTextCopy: string;
   sharedTextClear: string;
   sharedTextShare: string;
   sharedTextByteCount: (current: number, maximum: number) => string;
   sharedTextTooLarge: string;
   sharedTextConflictTitle: string;
   sharedTextConflictMessage: string;
   sharedTextUseLatest: string;
   sharedTextReplace: string;
   diagnostics: string;
   roomQr: string;
   readyToConnect: string;
   filesCount: (count: number) => string;
   copied: string;
   transfers: string;
   incoming: string;
   outgoing: string;
   downloadFile: (name: string) => string;
   download: string;
   showInFolderFile: (name: string) => string;
   showInFolder: string;
   cancelFile: (name: string) => string;
   cancel: string;
   stateReady: string;
   stateComplete: string;
   stateFailed: string;
   stateCancelled: string;
   stateWaiting: string;
   diagnosticsTitle: string;
   diagnosticsLoading: string;
   diagnosticsUnavailable: string;
   diagnosticsVersion: string;
   diagnosticsProtocol: string;
   diagnosticsPort: string;
   diagnosticsUptime: string;
   diagnosticsRestarts: string;
   diagnosticsRoomsItems: string;
   diagnosticsActivity: string;
   diagnosticsDisk: string;
   diagnosticsLog: string;
   diagnosticsErrors: string;
   copyDiagnostics: string;
   openLogFolder: string;
   close: string;
   noRecentErrors: string;
   seconds: (value: number) => string;
   roomsItems: (rooms: number, items: number) => string;
   activeCounts: (writes: number, reads: number) => string;
}

const english: MessageCatalog = {
   appName: "Local File Transfer",
   openingRoom: "Opening room...",
   desktopRoomUnavailable: "Desktop room is not available",
   missingRoomId: "Room id is missing",
   connected: "Connected",
   openingFailed: "Could not open room",
   refreshFailed: "Room refresh failed",
   reconnecting: "Reconnecting...",
   roomEnded: "This room has ended. Scan the new QR code.",
   addingFiles: "Adding files...",
   ready: "Ready",
   addFilesFailed: "Could not add files",
   creatingRoom: "Creating room...",
   resetFailed: "Could not reset room",
   preparingFile: (current, total) => `Preparing ${current} of ${total}`,
   uploadingFile: (current, total) => `Uploading ${current} of ${total}`,
   uploadPaused: "Upload paused",
   pausing: "Pausing...",
   filesNeedRetry: (count) => `${count} file(s) need retry`,
   retryExplanation: "Some files could not be uploaded. Choose Resume to retry them.",
   uploadComplete: "Upload complete",
   cancelFailed: "Could not cancel transfer",
   refreshRoom: "Refresh room",
   chooseFiles: "Choose files",
   pause: "Pause",
   resume: "Resume",
   uploadCount: (count) => `Upload ${count}`,
   selectedFiles: "Selected files",
   removeSelectedFile: (name) => `Remove ${name}`,
   downloadAll: (count) => `Download all (${count})`,
   downloadAllName: "Local File Transfer.zip",
   addFiles: "Add files",
   copyRoomLink: "Copy room link",
   copyLink: "Copy link",
   resetRoom: "Reset room",
   sharedText: "Shared text",
   sharedTextUnread: "New shared text",
   sharedTextTitle: "Shared text",
   sharedTextAreaLabel: "Text to share",
   sharedTextPlaceholder: "Enter text",
   sharedTextLoading: "Loading...",
   sharedTextUnavailable: "Shared text is unavailable.",
   sharedTextUpToDate: "Up to date",
   sharedTextUnsaved: "Not shared",
   sharedTextShared: "Shared",
   sharedTextSaving: "Sharing...",
   sharedTextCopied: "Copied",
   sharedTextCopy: "Copy",
   sharedTextClear: "Clear draft",
   sharedTextShare: "Share",
   sharedTextByteCount: (current, maximum) => `${current} / ${maximum} bytes`,
   sharedTextTooLarge: "Keep the text within 64 KiB.",
   sharedTextConflictTitle: "Changed on another device",
   sharedTextConflictMessage: "Use the latest text or replace it with this draft.",
   sharedTextUseLatest: "Use latest",
   sharedTextReplace: "Replace with draft",
   diagnostics: "Diagnostics",
   roomQr: "Transfer room QR code",
   readyToConnect: "Ready to connect",
   filesCount: (count) => `${count} file(s)`,
   copied: "Copied",
   transfers: "Transfers",
   incoming: "Incoming",
   outgoing: "Outgoing",
   downloadFile: (name) => `Download ${name}`,
   download: "Download",
   showInFolderFile: (name) => `Show ${name} in folder`,
   showInFolder: "Show in folder",
   cancelFile: (name) => `Cancel ${name}`,
   cancel: "Cancel",
   stateReady: "ready",
   stateComplete: "complete",
   stateFailed: "failed",
   stateCancelled: "cancelled",
   stateWaiting: "waiting",
   diagnosticsTitle: "Diagnostics",
   diagnosticsLoading: "Loading diagnostics...",
   diagnosticsUnavailable: "Diagnostics are unavailable.",
   diagnosticsVersion: "Version",
   diagnosticsProtocol: "Protocol",
   diagnosticsPort: "Port",
   diagnosticsUptime: "Uptime",
   diagnosticsRestarts: "Service restarts",
   diagnosticsRoomsItems: "Rooms / files",
   diagnosticsActivity: "Active writes / reads",
   diagnosticsDisk: "Disk",
   diagnosticsLog: "Log",
   diagnosticsErrors: "Recent errors",
   copyDiagnostics: "Copy diagnostics",
   openLogFolder: "Open log folder",
   close: "Close",
   noRecentErrors: "None",
   seconds: (value) => `${value} sec`,
   roomsItems: (rooms, items) => `${rooms} / ${items}`,
   activeCounts: (writes, reads) => `${writes} / ${reads}`
};

const japanese: MessageCatalog = {
   appName: "Local File Transfer",
   openingRoom: "ルームを開いています...",
   desktopRoomUnavailable: "デスクトップのルームを利用できません",
   missingRoomId: "ルーム ID がありません",
   connected: "接続済み",
   openingFailed: "ルームを開けませんでした",
   refreshFailed: "ルームを更新できませんでした",
   reconnecting: "再接続しています...",
   roomEnded: "このルームは終了しました。新しい QR コードを読み取ってください。",
   addingFiles: "ファイルを追加しています...",
   ready: "準備完了",
   addFilesFailed: "ファイルを追加できませんでした",
   creatingRoom: "ルームを作成しています...",
   resetFailed: "ルームを再作成できませんでした",
   preparingFile: (current, total) => `${current} / ${total} を準備中`,
   uploadingFile: (current, total) => `${current} / ${total} をアップロード中`,
   uploadPaused: "アップロードを一時停止しました",
   pausing: "一時停止しています...",
   filesNeedRetry: (count) => `${count} 件を再試行してください`,
   retryExplanation: "一部のファイルを送信できませんでした。再開を選んで再試行してください。",
   uploadComplete: "アップロード完了",
   cancelFailed: "転送を中止できませんでした",
   refreshRoom: "ルームを更新",
   chooseFiles: "ファイルを選択",
   pause: "一時停止",
   resume: "再開",
   uploadCount: (count) => `${count} 件をアップロード`,
   selectedFiles: "選択したファイル",
   removeSelectedFile: (name) => `${name} を選択から外す`,
   downloadAll: (count) => `すべてダウンロード (${count})`,
   downloadAllName: "Local File Transfer.zip",
   addFiles: "ファイルを追加",
   copyRoomLink: "ルームリンクをコピー",
   copyLink: "リンクをコピー",
   resetRoom: "ルームをリセット",
   sharedText: "共有テキスト",
   sharedTextUnread: "新しい共有テキスト",
   sharedTextTitle: "共有テキスト",
   sharedTextAreaLabel: "共有するテキスト",
   sharedTextPlaceholder: "テキストを入力",
   sharedTextLoading: "読み込み中...",
   sharedTextUnavailable: "共有テキストを読み込めませんでした。",
   sharedTextUpToDate: "最新です",
   sharedTextUnsaved: "未共有の変更",
   sharedTextShared: "共有しました",
   sharedTextSaving: "共有中...",
   sharedTextCopied: "コピーしました",
   sharedTextCopy: "コピー",
   sharedTextClear: "下書きを消去",
   sharedTextShare: "共有",
   sharedTextByteCount: (current, maximum) => `${current} / ${maximum} バイト`,
   sharedTextTooLarge: "64 KiB 以下にしてください。",
   sharedTextConflictTitle: "別の端末で更新されました",
   sharedTextConflictMessage: "最新の内容を使うか、この下書きで置き換えてください。",
   sharedTextUseLatest: "最新を使う",
   sharedTextReplace: "下書きで置換",
   diagnostics: "診断情報",
   roomQr: "転送ルームの QR コード",
   readyToConnect: "接続待ち",
   filesCount: (count) => `${count} ファイル`,
   copied: "コピー済み",
   transfers: "転送一覧",
   incoming: "受信",
   outgoing: "送信",
   downloadFile: (name) => `${name} をダウンロード`,
   download: "ダウンロード",
   showInFolderFile: (name) => `${name} をフォルダーで表示`,
   showInFolder: "フォルダーで表示",
   cancelFile: (name) => `${name} の転送を中止`,
   cancel: "中止",
   stateReady: "準備完了",
   stateComplete: "完了",
   stateFailed: "失敗",
   stateCancelled: "中止",
   stateWaiting: "待機中",
   diagnosticsTitle: "診断情報",
   diagnosticsLoading: "診断情報を読み込んでいます...",
   diagnosticsUnavailable: "診断情報を取得できません。",
   diagnosticsVersion: "バージョン",
   diagnosticsProtocol: "プロトコル",
   diagnosticsPort: "ポート",
   diagnosticsUptime: "稼働時間",
   diagnosticsRestarts: "サービス再起動",
   diagnosticsRoomsItems: "ルーム / ファイル",
   diagnosticsActivity: "書込 / 読出",
   diagnosticsDisk: "ディスク",
   diagnosticsLog: "ログ",
   diagnosticsErrors: "最近のエラー",
   copyDiagnostics: "診断情報をコピー",
   openLogFolder: "ログフォルダーを開く",
   close: "閉じる",
   noRecentErrors: "なし",
   seconds: (value) => `${value} 秒`,
   roomsItems: (rooms, items) => `${rooms} / ${items}`,
   activeCounts: (writes, reads) => `${writes} / ${reads}`
};

export function resolveLocale(languages: readonly string[]): SupportedLocale {
   for (const language of languages) {
      if (language.toLowerCase().split("-", 1)[0] === "ja") {
         return "ja";
      }
   }

   return "en";
}

export function catalogForLanguages(languages: readonly string[]): {
   locale: SupportedLocale;
   messages: MessageCatalog;
} {
   const locale = resolveLocale(languages);

   return {
      locale,
      messages: locale === "ja" ? japanese : english
   };
}

export function useLocale(): { locale: SupportedLocale; messages: MessageCatalog } {
   const selection = useMemo(
      () => catalogForLanguages(navigator.languages.length > 0 ? navigator.languages : [navigator.language]),
      []
   );

   useEffect(() => {
      document.documentElement.lang = selection.locale;
   }, [selection.locale]);

   return selection;
}
