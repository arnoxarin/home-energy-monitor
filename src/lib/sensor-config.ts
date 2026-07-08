import { Activity, Cpu, Power, Radar, Thermometer, Waves, Zap } from "lucide-react";
import type { ComponentType } from "react";

export type SensorKind = "pzem04" | "dht22" | "relay" | "analog" | "digital" | "ultrasonic" | "radar";
export type SensorView = "graph" | "numeric" | "button";

export type PinInfo = { pin: string; label: string };

// ESP32 (classic / DevKit v1) pin capability lists.
// Notes:
//   - GPIO 6-11 are wired to the SPI flash and must never be exposed.
//   - GPIO 34-39 are input-only (no output, no internal pull-up/down).
//   - ADC2 pins conflict with Wi-Fi, so only ADC1 pins are offered for analog input.
//   - Strapping pins (0, 2, 5, 12, 15) are usable but flagged in the label.
const ANY_OUTPUT: PinInfo[] = [
  { pin: "2",  label: "GPIO 2 (strapping, onboard LED)" },
  { pin: "4",  label: "GPIO 4" },
  { pin: "5",  label: "GPIO 5 (strapping)" },
  { pin: "12", label: "GPIO 12 (strapping)" },
  { pin: "13", label: "GPIO 13" },
  { pin: "14", label: "GPIO 14" },
  { pin: "15", label: "GPIO 15 (strapping)" },
  { pin: "16", label: "GPIO 16" },
  { pin: "17", label: "GPIO 17" },
  { pin: "18", label: "GPIO 18" },
  { pin: "19", label: "GPIO 19" },
  { pin: "21", label: "GPIO 21 (default SDA)" },
  { pin: "22", label: "GPIO 22 (default SCL)" },
  { pin: "23", label: "GPIO 23" },
  { pin: "25", label: "GPIO 25 (DAC)" },
  { pin: "26", label: "GPIO 26 (DAC)" },
  { pin: "27", label: "GPIO 27" },
  { pin: "32", label: "GPIO 32" },
  { pin: "33", label: "GPIO 33" },
];

const ANY_DIGITAL_IO: PinInfo[] = [
  ...ANY_OUTPUT,
  { pin: "34", label: "GPIO 34 (input only)" },
  { pin: "35", label: "GPIO 35 (input only)" },
  { pin: "36", label: "GPIO 36 / VP (input only)" },
  { pin: "39", label: "GPIO 39 / VN (input only)" },
];

const ADC1_PINS: PinInfo[] = [
  { pin: "32", label: "GPIO 32 (ADC1_4)" },
  { pin: "33", label: "GPIO 33 (ADC1_5)" },
  { pin: "34", label: "GPIO 34 (ADC1_6, input only)" },
  { pin: "35", label: "GPIO 35 (ADC1_7, input only)" },
  { pin: "36", label: "GPIO 36 / VP (ADC1_0, input only)" },
  { pin: "39", label: "GPIO 39 / VN (ADC1_3, input only)" },
];

const UART_RX_PINS: PinInfo[] = [
  { pin: "16", label: "GPIO 16 (UART2 RX — recommended)" },
  { pin: "9",  label: "GPIO 9 (UART1 RX — flash pin, avoid)" },
  { pin: "4",  label: "GPIO 4" },
  { pin: "13", label: "GPIO 13" },
  { pin: "14", label: "GPIO 14" },
  { pin: "25", label: "GPIO 25" },
  { pin: "26", label: "GPIO 26" },
  { pin: "27", label: "GPIO 27" },
  { pin: "32", label: "GPIO 32" },
  { pin: "33", label: "GPIO 33" },
  { pin: "34", label: "GPIO 34 (input only)" },
  { pin: "35", label: "GPIO 35 (input only)" },
];

const UART_TX_PINS: PinInfo[] = [
  { pin: "17", label: "GPIO 17 (UART2 TX — recommended)" },
  { pin: "10", label: "GPIO 10 (UART1 TX — flash pin, avoid)" },
  { pin: "4",  label: "GPIO 4" },
  { pin: "13", label: "GPIO 13" },
  { pin: "14", label: "GPIO 14" },
  { pin: "25", label: "GPIO 25" },
  { pin: "26", label: "GPIO 26" },
  { pin: "27", label: "GPIO 27" },
  { pin: "32", label: "GPIO 32" },
  { pin: "33", label: "GPIO 33" },
];

export type PinRoleKey = "rx" | "tx" | "data" | "trig" | "echo" | "signal" | "out";
export interface PinRole {
  key: PinRoleKey;
  label: string;
  hint: string;
  options: PinInfo[];
}

export const PIN_ROLES: Record<SensorKind, PinRole[]> = {
  pzem04: [
    { key: "rx", label: "ESP32 RX pin", hint: "Wire to PZEM TX. Any UART-capable input pin.", options: UART_RX_PINS },
    { key: "tx", label: "ESP32 TX pin", hint: "Wire to PZEM RX. Must be output-capable.",     options: UART_TX_PINS },
  ],
  radar: [
    { key: "rx", label: "ESP32 RX pin", hint: "Wire to radar TX.", options: UART_RX_PINS },
    { key: "tx", label: "ESP32 TX pin", hint: "Wire to radar RX.", options: UART_TX_PINS },
  ],
  dht22: [
    { key: "data", label: "Data pin", hint: "Single-wire data. Needs a 4.7kΩ pull-up. Avoid input-only pins.", options: ANY_OUTPUT },
  ],
  relay: [
    { key: "out", label: "Relay control pin", hint: "Drives the relay coil. Output-capable pin required.", options: ANY_OUTPUT },
  ],
  digital: [
    { key: "signal", label: "Input pin", hint: "Reads HIGH / LOW.", options: ANY_DIGITAL_IO },
  ],
  analog: [
    { key: "signal", label: "ADC pin", hint: "Analog input. ADC2 pins are excluded (they conflict with Wi-Fi).", options: ADC1_PINS },
  ],
  ultrasonic: [
    { key: "trig", label: "TRIG pin", hint: "Output pulse to the sensor.", options: ANY_OUTPUT },
    { key: "echo", label: "ECHO pin", hint: "Reads pulse back. Use a level shifter (5V → 3.3V).", options: ANY_DIGITAL_IO },
  ],
};

export interface KindMeta {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  defaultView: SensorView;
  unit?: string;
  allowedViews: SensorView[];
}

export const KIND_META: Record<SensorKind, KindMeta> = {
  pzem04:     { label: "PZEM-004T (Power)",     description: "UART. Voltage, current, power, energy.",         icon: Zap,         defaultView: "graph",   unit: "W",  allowedViews: ["graph", "numeric"] },
  dht22:      { label: "DHT22 (Temp/Humidity)", description: "1-wire data pin with pull-up.",                  icon: Thermometer, defaultView: "graph",   unit: "°C", allowedViews: ["graph", "numeric"] },
  relay:      { label: "Relay / Switch",        description: "One output pin to drive the coil.",              icon: Power,       defaultView: "button",              allowedViews: ["button"] },
  analog:     { label: "Analog input",          description: "ADC1 pin. Raw 0-4095 reading.",                  icon: Activity,    defaultView: "graph",               allowedViews: ["graph", "numeric"] },
  digital:    { label: "Digital input",         description: "HIGH/LOW state of a GPIO.",                      icon: Cpu,         defaultView: "numeric",             allowedViews: ["numeric", "graph"] },
  ultrasonic: { label: "Ultrasonic HC-SR04",    description: "Two pins: TRIG (output) + ECHO (input).",        icon: Waves,       defaultView: "graph",   unit: "cm", allowedViews: ["graph", "numeric"] },
  radar:      { label: "Radar (LD2410 etc.)",   description: "UART. Presence + distance.",                     icon: Radar,       defaultView: "graph",               allowedViews: ["graph", "numeric"] },
};
