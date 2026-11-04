export type Draft<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? T
	: T extends null | boolean | number | string | ((...args: never[]) => unknown)
		? T
		: T extends object
			? { -readonly [Key in keyof T]: Draft<T[Key], [...Depth, unknown]> }
			: T;
