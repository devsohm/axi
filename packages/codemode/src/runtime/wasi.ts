export function quietOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, buffers: number, count: number, written: number): number {
			const view = new DataView(memory.buffer);
			let length = 0;
			for (let i = 0; i < count; i++) length += view.getUint32(buffers + 8 * i + 4, true);
			view.setUint32(written, length, true);
			return 0;
		},
	};
}
