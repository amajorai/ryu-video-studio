/**
 * Raw (pre-parse) segments for the `mediaLayerStyle` snapshot test. They use
 * only fields that existed before the Wave 0 preview split, so the expected
 * values were captured by running the pre-refactor `MediaLayer` formula
 * against the same inputs. Keep this file free of imports.
 */

const assetId = "00000000-0000-4000-8000-0000000000a1";

const base = {
	assetId,
	brightness: 0,
	contrast: 1,
	fadeIn: 0,
	fadeOut: 0,
	opacity: 1,
	saturation: 1,
	scale: 1,
	sourceIn: 0,
	sourceOut: 10,
	speed: 1,
	start: 0,
	track: 0,
	volume: 1,
	x: 0,
	y: 0,
};

export interface MediaLayerFixture {
	name: string;
	segment: Record<string, unknown>;
	time: number;
}

export const mediaLayerFixtures: MediaLayerFixture[] = [
	{
		name: "plain clip mid-way",
		segment: { ...base, id: "00000000-0000-4000-8000-000000000001" },
		time: 4,
	},
	{
		name: "inactive before start",
		segment: {
			...base,
			id: "00000000-0000-4000-8000-000000000002",
			start: 5,
			track: 1,
		},
		time: 2,
	},
	{
		name: "keyframed transform and opacity",
		segment: {
			...base,
			id: "00000000-0000-4000-8000-000000000003",
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000301",
					property: "x",
					time: 0,
					value: -0.5,
				},
				{
					id: "00000000-0000-4000-8000-000000000302",
					property: "x",
					time: 4,
					value: 0.5,
				},
				{
					id: "00000000-0000-4000-8000-000000000303",
					property: "scale",
					time: 1,
					value: 1,
				},
				{
					id: "00000000-0000-4000-8000-000000000304",
					property: "scale",
					time: 3,
					value: 2,
				},
				{
					id: "00000000-0000-4000-8000-000000000305",
					property: "rotation",
					time: 0,
					value: 0,
				},
				{
					id: "00000000-0000-4000-8000-000000000306",
					property: "rotation",
					time: 2,
					value: 90,
				},
				{
					id: "00000000-0000-4000-8000-000000000307",
					property: "opacity",
					time: 0,
					value: 0.2,
				},
				{
					id: "00000000-0000-4000-8000-000000000308",
					property: "opacity",
					time: 2,
					value: 1,
				},
				{
					id: "00000000-0000-4000-8000-000000000309",
					property: "y",
					time: 2,
					value: 0.25,
				},
			],
			start: 1,
		},
		time: 2.5,
	},
	{
		name: "slide-left entry transition",
		segment: {
			...base,
			entryDuration: 1,
			entryTransition: "slide-left",
			id: "00000000-0000-4000-8000-000000000004",
			x: 0.2,
		},
		time: 0.25,
	},
	{
		name: "zoom-in entry with offset",
		segment: {
			...base,
			entryDuration: 0.8,
			entryOffset: 0.2,
			entryTransition: "zoom-in",
			id: "00000000-0000-4000-8000-000000000005",
			scale: 1.5,
		},
		time: 0.2,
	},
	{
		name: "crossfade entry with fades",
		segment: {
			...base,
			entryDuration: 0.5,
			entryTransition: "crossfade",
			fadeIn: 1,
			fadeOut: 2,
			id: "00000000-0000-4000-8000-000000000006",
			opacity: 0.8,
		},
		time: 0.3,
	},
	{
		name: "crop with rounded soft edges",
		segment: {
			...base,
			crop: { bottom: 0.05, left: 0.1, right: 0.2, top: 0.15 },
			edgeRounding: 0.25,
			edgeSoftness: 6,
			id: "00000000-0000-4000-8000-000000000007",
			track: 2,
		},
		time: 1,
	},
	{
		name: "legacy blur with an effect stack",
		segment: {
			...base,
			effects: [
				{ amount: 0.5, type: "blur" },
				{ amount: 0.75, type: "sharpen" },
				{ amount: 0.6, type: "vignette" },
				{ amount: 0.3, enabled: false, type: "grayscale" },
				{ amount: 0.4, type: "sepia" },
			],
			id: "00000000-0000-4000-8000-000000000008",
			visualEffect: "blur",
		},
		time: 2,
	},
	{
		name: "sepia with a colour grade",
		segment: {
			...base,
			brightness: 0.2,
			colorGrade: {
				exposure: 0.6,
				temperature: 0.5,
				tint: -0.25,
				vibrance: 0.4,
			},
			contrast: 1.3,
			id: "00000000-0000-4000-8000-000000000009",
			saturation: 0.7,
			visualEffect: "sepia",
		},
		time: 3,
	},
	{
		name: "grayscale fading out on an upper track",
		segment: {
			...base,
			fadeOut: 2,
			id: "00000000-0000-4000-8000-000000000010",
			speed: 2,
			start: 2,
			track: 3,
			visualEffect: "grayscale",
		},
		time: 6,
	},
];
