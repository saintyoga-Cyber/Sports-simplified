# Sports Simplified

A simple Pebble watchapp that pushes NHL game timeline pins for the Vancouver Canucks and Montreal Canadiens.

## How It Works

This app works with a companion web service that:
1. Fetches NHL game data from ESPN's API
2. Pushes timeline pins to your Pebble watch via the Rebble API
3. Updates automatically every 2 hours (every 2 minutes during live games)

## Setup

1. **Companion URL is pre-configured**: The app is already configured to use `https://localhost:5000` as the companion service.

2. **Build the app**:
   ```bash
   pebble build
   ```

3. **Install on your watch**:
   ```bash
   pebble install --phone YOUR_PHONE_IP
   ```
   Or install the `.pbw` file from `build/` through the Pebble app.

## Timeline Pins

Once installed, the app automatically registers with the companion service. You'll receive timeline pins showing:

- **Upcoming games**: Shows game time with a 15-minute reminder
- **Live games**: Updates with current score and period
- **Final scores**: Shows the final result

## Followed Teams

- Vancouver Canucks (VAN)
- Montreal Canadiens (MTL)

## Requirements

- Pebble SDK 3.x
- A running instance of the Pebble Dev Companion with Sports Timeline feature
- Rebble services (for timeline functionality)

## Building

This app requires the Pebble SDK. You can build it using:

- [Rebble's online tool](https://rebble.io/)
- A local Pebble SDK installation
- The Pebble development Docker container

## License

MIT License
