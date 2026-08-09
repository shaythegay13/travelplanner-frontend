"use client";

import { useState } from "react";
import AccountSetup from "@/components/AccountSetup";
import TripSetup from "@/components/TripSetup";
import GroupTripPlanner from "@/components/GroupTripPlanner";

// In memory only. No database, no auth, no persistence — the "account" lives for
// the length of the session and nothing about the user is written anywhere.
export default function Home() {
  const [stage, setStage] = useState("account"); // account | trip | planner
  const [profile, setProfile] = useState(null);
  const [trip, setTrip] = useState(null);

  if (stage === "account") {
    return (
      <AccountSetup
        onReady={(p) => {
          setProfile(p);
          setStage("trip");
        }}
        onSkip={() => setStage("trip")}
      />
    );
  }

  if (stage === "trip") {
    return (
      <TripSetup
        initialTraveler={profile}
        onReady={(t) => {
          setTrip(t);
          setStage("planner");
        }}
        onSkip={() => setStage("planner")}
      />
    );
  }

  // No trip prop => the component falls back to its hardcoded TRIP.
  return <GroupTripPlanner trip={trip || undefined} />;
}
