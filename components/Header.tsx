import { checkUser } from "@/lib/checkUser";
import HeaderClient from "@/components/HeaderClient";

export default async function Header() {
  const user = await checkUser();
  return <HeaderClient initialCredits={user?.credits ?? null} />;
}
