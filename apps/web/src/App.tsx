import { ReceivePage } from "./pages/ReceivePage.tsx";
import { TransferRoomPage } from "./pages/TransferRoomPage.tsx";
import { SendPage } from "./pages/SendPage.tsx";
import { UploadPage } from "./pages/UploadPage.tsx";

export function App(): JSX.Element {
   const path = window.location.pathname;

   if (path === "/app") {
      return <TransferRoomPage />;
   }

   if (path.startsWith("/room/")) {
      return <TransferRoomPage roomId={decodeURIComponent(path.slice("/room/".length))} />;
   }

   if (path.startsWith("/r/")) {
      return <ReceivePage sid={decodeURIComponent(path.slice("/r/".length))} />;
   }

   if (path.startsWith("/u/")) {
      return <UploadPage sid={decodeURIComponent(path.slice("/u/".length))} />;
   }

   return window.localFileTransfer ? <TransferRoomPage /> : <SendPage />;
}
