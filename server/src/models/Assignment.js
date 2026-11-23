import mongoose from "mongoose";

const assignmentSchema = new mongoose.Schema(
  {
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmergencyRequest",
      required: true,
      index: true,
    },
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Provider",
      required: true,
      index: true,
    },
    acceptedAt: Date,
    estimatedArrival: Date,
    status: {
      type: String,
      enum: [
        "offered",
        "accepted",
        "declined",
        "in_progress",
        "partially_fulfilled",
        "fulfilled",
        "cancelled",
      ],
      default: "offered",
      index: true,
    },
    reservedResources: [
      {
        resourceId: { type: mongoose.Schema.Types.ObjectId, ref: "Resource" },
        resourceType: { type: String, required: true },
        quantity: { type: Number, min: 0, required: true },
        unit: { type: String, required: true },
      },
    ],
    quantityCommitted: { type: Number, min: 0, default: 0 },
    quantityFulfilled: { type: Number, min: 0, default: 0 },
    completedAt: Date,
    outcome: {
      type: String,
      enum: ["successful", "partial", "unsuccessful", "cancelled"],
    },
  },
  { timestamps: true },
);

assignmentSchema.index({ requestId: 1, providerId: 1 }, { unique: true });
assignmentSchema.index({ providerId: 1, status: 1, createdAt: -1 });

export default mongoose.models.Assignment ||
  mongoose.model("Assignment", assignmentSchema);
