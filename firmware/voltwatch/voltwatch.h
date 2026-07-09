// Types shared inside the Voltwatch firmware.
// Kept in a header so the Arduino preprocessor's auto-generated function
// prototypes (which get injected ABOVE the .ino body) can already see them.
#pragma once

#include <Arduino.h>
#include <DHT.h>

struct Sensor {
  String id;
  String kind;   // "dht22" | "relay" | "analog" | "digital" | "ultrasonic" | ...
  int    pin;    // primary pin (data / signal / out)
  int    pinB;   // secondary pin (e.g. ultrasonic ECHO), -1 if unused
  bool   desiredOn; // for relays
  DHT*   dht;    // lazily allocated for DHT22
};
