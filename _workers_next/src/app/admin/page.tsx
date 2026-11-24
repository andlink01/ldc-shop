import { redirect } from "next/navigation"
import { requireAdminPage } from "@/lib/admin-guard"

export default async function AdminPage() {
    await requireAdminPage()
    redirect('/admin/settings')
}
