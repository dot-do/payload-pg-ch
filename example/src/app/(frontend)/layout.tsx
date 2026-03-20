import React from 'react'

export const metadata = {
  title: 'payload-pg-ch Example',
  description: 'Payload CMS with ClickHouse-backed PostgreSQL adapter',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
