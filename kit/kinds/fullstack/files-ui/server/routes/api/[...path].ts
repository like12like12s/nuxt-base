// Same-origin API: the browser calls /api/** on the UI, the UI server forwards it to the API. No API host ends up in
// the browser bundle, so the app works unchanged behind a tunnel or a reverse proxy.
import { apiTarget } from '../../utils/api-target'

export default defineEventHandler((event) => proxyRequest(event, apiTarget(process.env.API_URL, event.path)))
