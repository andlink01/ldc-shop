import { LoginContent } from '@/components/login-content'

export const dynamic = 'force-dynamic'

export default function LoginPage() {
  return <LoginContent providers={{
    linuxdo: Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET),
    github: Boolean((process.env.GITHUB_ID || process.env.AUTH_GITHUB_ID) && (process.env.GITHUB_SECRET || process.env.AUTH_GITHUB_SECRET)),
  }} />
}
