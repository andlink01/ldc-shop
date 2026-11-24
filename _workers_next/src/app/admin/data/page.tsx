import { requireAdminPage } from "@/lib/admin-guard"
import { AdminDataContent } from "@/components/admin/export-content"

export default async function AdminDataPage() {
  await requireAdminPage()
  return <AdminDataContent />
}

