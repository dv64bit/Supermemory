// supermem: replaces the hosted "Sign in" flow. Saves server URL + API key, then validates them.
import { useEffect, useState } from "react"
import { validateAuthToken } from "../../utils/api"
import { DEFAULT_SERVER_URL } from "../../utils/constants"
import { bearerToken, serverUrl, userData } from "../../utils/storage"

export function ConnectForm({ onConnected }: { onConnected: () => void }) {
	const [url, setUrl] = useState(DEFAULT_SERVER_URL)
	const [key, setKey] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		serverUrl.getValue().then(setUrl)
	}, [])

	const connect = async () => {
		setBusy(true)
		setError(null)
		try {
			const base = url.trim().replace(/\/+$/, "")
			if (!/^https?:\/\//.test(base)) throw new Error("Server URL must start with http:// or https://")
			await Promise.all([serverUrl.setValue(base), bearerToken.setValue(key.trim())])
			// validateAuthToken returns true on network errors too; probe health first so a wrong URL is caught.
			const health = await fetch(`${base}/v3/health`).catch(() => null)
			if (!health?.ok) throw new Error(`Can't reach ${base}. Is the server running?`)
			if (!(await validateAuthToken())) throw new Error("Server rejected the API key")
			await userData.setValue({ name: "supermem", email: base })
			onConnected()
		} catch (e) {
			await bearerToken.removeValue()
			setError(e instanceof Error ? e.message : String(e))
		} finally {
			setBusy(false)
		}
	}

	const input =
		"w-full mb-3 py-2.5 px-3 rounded-lg border border-neutral-700 bg-neutral-900 text-sm text-neutral-100 outline-none focus:border-sky-500"
	return (
		<form
			className="mt-8 text-left"
			onSubmit={(e) => {
				e.preventDefault()
				connect()
			}}
		>
			<label className="block mb-1 text-xs text-neutral-400" htmlFor="sm-url">
				Server URL
			</label>
			<input className={input} id="sm-url" onChange={(e) => setUrl(e.target.value)} value={url} />
			<label className="block mb-1 text-xs text-neutral-400" htmlFor="sm-key">
				API key
			</label>
			<input
				autoComplete="off"
				className={input}
				id="sm-key"
				onChange={(e) => setKey(e.target.value)}
				placeholder="SUPERMEM_API_KEY"
				type="password"
				value={key}
			/>
			{error && <p className="m-0 mb-3 text-xs text-red-300">{error}</p>}
			<button
				className="w-full py-3 px-6 bg-[#2d3f5c] text-white border-none rounded-3xl text-base font-medium cursor-pointer transition-colors duration-200 hover:bg-[#3d5270] disabled:bg-neutral-600 disabled:cursor-not-allowed"
				disabled={busy || !key.trim()}
				type="submit"
			>
				{busy ? "Connecting…" : "Connect"}
			</button>
		</form>
	)
}
