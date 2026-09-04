# APEX — Hypercar Simulator

Ein 3-D-Autosimulator im Browser, mit echtem Lenkrad auf dem Handy.
Läuft komplett offline, ohne Build-Schritt und ohne einen einzigen Bild-Download —
jede Textur, jedes Fahrzeug und die ganze Strecke werden zur Laufzeit im Code erzeugt.

## Die drei Autos

| | Motor | Leistung | 0–100 | Vmax | Antrieb |
|---|---|---|---|---|---|
| **Lamborghini Huracán EVO** | 5,2 l V10 | 640 PS | 2,9 s | 325 km/h | Allrad |
| **Pagani Zonda HP Barchetta** | 7,3 l V12 | 802 PS | 3,0 s | 350 km/h | Heck |
| **Lamborghini Huracán STO** | 5,2 l V10 | 640 PS | 3,0 s | 310 km/h | Heck |

Der Zonda ist der Roadster, von dem nur **drei Stück** gebaut wurden — offenes Dach,
Dorsalfinne, verkleidete Hinterräder, freiliegendes Karbon.

## Spielen

Nichts zu installieren, nichts zu bauen. Die Seite ist statisch:

```bash
git clone https://github.com/levithomas15/Carparking
cd Carparking
python3 -m http.server 8080      # oder: npx serve .
```

Dann `http://localhost:8080` öffnen. Auf dem Handy: im Browser aufrufen und
über *Zum Home-Bildschirm* installieren — dann startet es im Vollbild wie eine App
und funktioniert auch ohne Netz.

> Ein Webserver wird gebraucht (nicht per Doppelklick öffnen), weil ES-Module und
> der Service Worker sonst von der Browser-Sicherheitsrichtlinie blockiert werden.

## Steuerung

**Handy** — ein echtes Lenkrad: irgendwo am Kranz anfassen und drehen, es folgt dem
Daumenwinkel und zentriert sich beim Loslassen selbst. Rechts Gas und Bremse als
druckempfindliche Pedale (weiter nach oben ziehen = mehr Gas), dazu Handbremse,
Schaltwippen, Reset, Hupe und Kamerawechsel. Alternativ Neigungssteuerung
(Einstellungen → Lenkung → Neigen).

**Tastatur** — `W/S` oder Pfeiltasten Gas/Bremse, `A/D` lenken, `Leertaste`
Handbremse, `E/Q` schalten, `C` Kamera, `R` Reset, `H` Hupe, `L` Licht, `Esc` Pause.
Gamepads werden ebenfalls erkannt.

## Was drinsteckt

**Grafik.** WebGL 2 mit ACES-Filmic-Tonemapping und HDR-Pipeline. Der Himmel ist ein
Rayleigh-/Mie-Streuungsmodell mit prozeduraler Wolkendecke, Sternen und Mond — und
er wird in eine Cubemap gerendert, aus der die PMREM-Faltung die Umgebungs-
beleuchtung erzeugt. Der Himmel, den man sieht, *ist* also das Licht der Szene.
Dazu eine lokale Reflexionssonde am Auto, damit sich Gebäude und Leitplanken im
Lack spiegeln. Nachbearbeitung: Bloom, Sonnenstrahlen, radiale Bewegungsunschärfe,
chromatische Aberration, Filmkorn, Vignette und Farbgrading in einem einzigen Pass.

**Lack.** `MeshPhysicalMaterial` mit Clearcoat-Schicht über metallischem Flake-
Normalmap — diese zweite Spiegelungsebene ist das, was gerenderten Autolack als
*Lack* lesbar macht statt als glänzendes Plastik.

**Karosserie.** Kein importiertes 3-D-Modell: jedes Auto entsteht aus Querschnitts-
Stationen, die per Catmull-Rom-Spline zu einer glatten Fläche interpoliert werden.
Radkästen werden in die Fläche geschnitten, Glas/Karbon/Zierteile über Material-
Patches im Parameterraum verteilt.

**Fahrphysik.** Starrkörper mit vier unabhängigen Federbeinen bei fester 240-Hz-
Schrittweite. Jedes Rad rechnet Schlupfrate und Schräglaufwinkel und holt sich seine
Kraft aus einem Reifenmodell auf dem Reibkreis — mit Lastabhängigkeit, damit
Gewichtsverlagerung spürbar wird. Dazu Drehmomentkurve, Getriebe mit Kupplung,
Sperrdifferenzial, Aerodynamik mit Abtrieb sowie ABS, Traktions- und
Stabilitätskontrolle zum Abschalten.

**Sound.** Keine Samples. Der Auspuff wird aus der Zündfrequenz synthetisiert, mit
einem Oberwellen-Stapel, der zur Zylinderzahl passt — deshalb klingen V10 und V12
nach verschiedenen Motoren und nicht nach demselben Brummen in anderer Tonhöhe.
Dazu Ansauggeräusch, Knallen im Schubbetrieb, Getriebeheulen, Reifenquietschen
und Fahrtwind.

**Leistung.** Vier Qualitätsstufen plus Automatik: Beim Start wird die GPU erkannt,
zur Laufzeit regelt eine adaptive Auflösungssteuerung nach, um die Bildrate zu halten.

## Struktur

```
index.html            App-Hülle, HUD, Lenkrad-SVG
src/core/             Mathe, Einstellungen, Qualitätsstufen
src/gfx/              Renderer, Himmel, Materialien, Texturen, Kamera, Partikel
src/cars/             Loft-System, Bauteile, die drei Fahrzeugdefinitionen
src/physics/          Fahrdynamik
src/world/            Strecke, Gelände, Stadt, Kollision
src/input/            Lenkrad, Tastatur, Gamepad, Neigung
src/audio/            Motorsynthese
src/ui/               Garage, HUD, Menüs
vendor/three/         three.js r185 (MIT), lokal eingebunden
```

## Rechtliches

Fan-Projekt zu Lern- und Demozwecken. Nicht lizenziert, nicht mit Automobili
Lamborghini oder Pagani Automobili verbunden; die Karosserien sind freie
Nachempfindungen, keine Reproduktionen. three.js steht unter MIT-Lizenz
(siehe `vendor/three/LICENSE`).
