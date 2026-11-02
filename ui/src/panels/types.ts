/** A library tab contributed by a registered panel. */
export interface PanelTab {
	label: string;
	/** Tab value; must be unique across the library tabs. */
	value: string;
}
