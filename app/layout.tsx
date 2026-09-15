import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppSidebar } from "@/components/AppSidebar";
import GlobalModals from "@/components/GlobalModals";
import KieBanner from "@/components/KieBanner";
import UpdateBanner from "@/components/UpdateBanner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cookies } from "next/headers";
import { DragDropGuard } from "@/components/DragDropGuard";


export const metadata: Metadata = {
  title: "HeliosGen",
  description: "Build AI image & video generation workflows visually",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html
      lang="en"
      className="antialiased dark"
      style={{
        height: "100%",
        "--font-geist-sans": "Arial, Helvetica, sans-serif",
        "--font-geist-mono": "\"Cascadia Mono\", Consolas, monospace",
        "--font-doto": "\"Cascadia Mono\", Consolas, monospace",
      } as React.CSSProperties}
    >
      <body className="bg-black text-white h-full overflow-hidden">
        <TooltipProvider>
          <SidebarProvider defaultOpen={sidebarOpen} className="h-full">
            <AppSidebar />
            <SidebarInset style={{ backgroundColor: "transparent" }} className="flex flex-col min-h-0 min-w-0 border-l border-r border-t border-white/[0.08] mx-2 mt-2 rounded-tl-xl rounded-tr-xl">
              <KieBanner />
              <UpdateBanner />
              <div className="md:hidden flex items-center h-10 px-3 border-b border-white/[0.08] shrink-0">
                <SidebarTrigger className="text-white/50 hover:text-white hover:bg-white/[0.05] transition-colors rounded-lg p-1.5 [&_svg]:size-4" />
              </div>
              <DragDropGuard />
        {children}
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
        <GlobalModals />
      </body>
    </html>
  );
}
