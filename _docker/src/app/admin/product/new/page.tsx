import { requireAdminPage } from "@/lib/admin-guard"
import ProductForm from "@/components/admin/product-form"
import { getCategories } from "@/lib/db/queries"

export default async function NewProductPage() {
    await requireAdminPage()
    const categories = await getCategories()
    return <ProductForm categories={categories} />
}
