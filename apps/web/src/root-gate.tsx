import { App } from './App'
import { BerandaApp } from './beranda/BerandaApp'

// RootGate (cutover titah 23 Sep): the DEFAULT composition at "/" is the
// native Beranda studio desk. The legacy guided shell (#56) remains reachable
// via the explicit feel/?guided gate — cutover replaces the default, it does
// not delete history. Pure by URL argument: no side effects, fully testable.
export function RootGate({ search = window.location.search }: { search?: string }) {
  if (search.includes('guided')) {
    return <App />
  }
  return <BerandaApp />
}
