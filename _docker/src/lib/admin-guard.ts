import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminUser } from '@/lib/admin-auth'

// A layout redirect does not stop its pages from rendering: Next.js renders
// them in parallel and streams page data first. Every admin page must call
// this before it reads anything.
export async function requireAdminPage() {
    const session = await auth()
    const user = session?.user
    if (!user || !isAdminUser(user)) redirect('/')
    return user
}
