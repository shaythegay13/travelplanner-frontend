import "./globals.css";

export const metadata = {
  title: "Group trip planner",
  description:
    "Plan a group trip everyone actually wants. Compress the itinerary, keep everyone's priorities.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
