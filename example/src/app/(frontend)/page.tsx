import React from 'react'

export default function Home() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h1>payload-pg-ch Example</h1>
      <p>Payload CMS running on the ClickHouse-backed PostgreSQL adapter.</p>
      <p>
        <a href="/admin" style={{ color: '#0070f3', textDecoration: 'underline' }}>
          Go to Admin Panel
        </a>
      </p>
    </div>
  )
}
