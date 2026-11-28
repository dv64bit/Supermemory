import { MESSAGE_TYPES } from "../../utils/constants"
import type { APIResponse } from "../../utils/types"
import { DOMUtils } from "../../utils/ui-components"
import { default as TurndownService } from "turndown"

export async function saveMemory(
	actionSource = "content_script",
): Promise<APIResponse> {
	try {
		DOMUtils.showToast("loading")

		const highlightedText = window.getSelection()?.toString() || ""
		const url = window.location.href

		const ogImage =
			document
				.querySelector('meta[property="og:image"]')
				?.getAttribute("content") ||
			document
				.querySelector('meta[name="og:image"]')
				?.getAttribute("content") ||
			undefined

		const title =
			document
				.querySelector('meta[property="og:title"]')
				?.getAttribute("content") ||
			document
				.querySelector('meta[name="og:title"]')
				?.getAttribute("content") ||
			document.title ||
			undefined

		const data: {
			html?: string
			markdown?: string
			highlightedText?: string
			url: string
			ogImage?: string
			title?: string
		} = {
			url,
		}

		if (ogImage) {
			data.ogImage = ogImage
		}

		if (title) {
			data.title = title
		}

		if (highlightedText) {
			data.highlightedText = highlightedText
		} else {
			const bodyClone = document.body.cloneNode(true) as HTMLElement
			const scripts = bodyClone.querySelectorAll("script")
			for (const script of scripts) {
				script.remove()
			}
			const html = bodyClone.innerHTML

			// Convert HTML to markdown
			const turndownService = new TurndownService()
			const markdown = turndownService.turndown(html)
			data.markdown = markdown
		}

		const response = (await browser.runtime.sendMessage({
			action: MESSAGE_TYPES.SAVE_MEMORY,
			data,
			actionSource,
		})) as APIResponse

		if (response?.success) {
			DOMUtils.showToast("success")
			return response
		}
		DOMUtils.showToast("error")
		return {
			success: false,
			error: response?.error || "Failed to save memory",
		}
	} catch (error) {
		console.error("Error saving memory:", error)
		DOMUtils.showToast("error")
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		}
	}
}

export function setupGlobalKeyboardShortcut() {
	document.addEventListener("keydown", async (event) => {
		if (
			(event.ctrlKey || event.metaKey) &&
			event.shiftKey &&
			event.key === "m"
		) {
			event.preventDefault()
			await saveMemory("keyboard_shortcut")
		}
	})
}

// supermem: the hosted app used to hand its login token to the extension here.
// Self-hosted, the server URL + API key are entered in the popup instead.
export function setupStorageListener() {}
