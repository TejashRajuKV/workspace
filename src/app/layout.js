import "./globals.css";

export const metadata = {
  title: "Infinite Workspace — Real-Time Collaborative Whiteboard + Code Editor",
  description:
    "A real-time collaborative development environment combining an infinite whiteboard and a collaborative code editor through a custom synchronization engine.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
