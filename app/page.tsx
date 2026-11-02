import { appPath } from "@/lib/appPaths";
import { redirect } from "next/navigation";
import { MANAGED_MODE } from "@/lib/managedMode";

export default function Home() {
  redirect(appPath(MANAGED_MODE ? "/workflow" : "/gallery?tab=images"));
}
