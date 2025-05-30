"use server";

import { createId } from "@/lib/api/create-id";
import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { getProgramOrThrow } from "@/lib/api/programs/get-program-or-throw";
import { createRewardSchema } from "@/lib/zod/schemas/rewards";
import { prisma } from "@dub/prisma";
import { authActionClient } from "../safe-action";

export const createRewardAction = authActionClient
  .schema(createRewardSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workspace } = ctx;
    const { partnerIds, event, amount, type, maxDuration, maxAmount } =
      parsedInput;

    const programId = getDefaultProgramIdOrThrow(workspace);

    const program = await getProgramOrThrow({
      workspaceId: workspace.id,
      programId,
    });

    if (maxAmount && maxAmount < amount) {
      throw new Error(
        "Max reward amount cannot be less than the reward amount.",
      );
    }

    let programEnrollments: { id: string }[] = [];

    // only one program-wide reward is allowed for each event
    if (!partnerIds || partnerIds.length === 0) {
      const programWideRewardCount = await prisma.reward.count({
        where: {
          event,
          programId,
          partners: {
            none: {},
          },
        },
      });

      if (programWideRewardCount > 0) {
        throw new Error(
          `There is an existing program-wide ${event} reward already. Either update the existing reward to be partner-specific or create a partner-specific reward.`,
        );
      }
    }

    if (partnerIds) {
      programEnrollments = await prisma.programEnrollment.findMany({
        where: {
          programId,
          partnerId: {
            in: partnerIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (programEnrollments.length !== partnerIds.length) {
        throw new Error("Invalid partner IDs provided.");
      }

      // only one partner-specific reward is allowed for each event for a partner
      const existingRewardCount = await prisma.partnerReward.count({
        where: {
          reward: {
            event,
            programId,
          },
          programEnrollment: {
            partnerId: {
              in: partnerIds,
            },
          },
        },
      });

      if (existingRewardCount > 0) {
        throw new Error(
          `Some of these partners already have an existing partner-specific ${event} reward. Remove those partners to continue.`,
        );
      }
    }

    const reward = await prisma.reward.create({
      data: {
        id: createId({ prefix: "rw_" }),
        programId,
        event,
        type,
        amount,
        maxDuration,
        maxAmount,
        ...(programEnrollments && {
          partners: {
            createMany: {
              data: programEnrollments.map(({ id }) => ({
                programEnrollmentId: id,
              })),
            },
          },
        }),
      },
    });

    // set the default reward if it doesn't exist
    if (
      !program.defaultRewardId &&
      ["lead", "sale"].includes(event) &&
      (!partnerIds || partnerIds.length === 0)
    ) {
      await prisma.program.update({
        where: {
          id: programId,
        },
        data: {
          defaultRewardId: reward.id,
        },
      });
    }
  });
