let flock;

export function setFlockReference(ref) {
  flock = ref;
}

export const flockMovement = {
  moveForward(modelName, speed) {
    const model = flock.scene.getMeshByName(modelName);
    if (!model || !model.physics || speed === 0) return;

    flock.ensureVerticalConstraint(model);

    const scene = flock.scene;
    const up = flock.BABYLON.Vector3.Up();

    if (!model.metadata) model.metadata = {};
    const md = model.metadata;

    // --- One-time locomotion collider normalization ---
    if (!md._locomotionColliderPrepared) {
      md._locomotionColliderPrepared = true;

      const shape = model.physics?.shape;
      const isCapsuleShape = shape instanceof flock.BABYLON.PhysicsShapeCapsule;

      // Ensure we have source capsule metrics (from metadata or bbox fallback)
      let sourceCap = md.physicsCapsule;
      if (
        !sourceCap ||
        typeof sourceCap.radius !== "number" ||
        typeof sourceCap.height !== "number"
      ) {
        model.computeWorldMatrix(true);
        const bb = model.getBoundingInfo().boundingBox;
        const localMin = bb.minimum;
        const localMax = bb.maximum;

        const height = Math.max(0.001, localMax.y - localMin.y);
        const width = Math.max(0.001, localMax.x - localMin.x);
        const depth = Math.max(0.001, localMax.z - localMin.z);
        const radius = Math.min(width, depth) / 2;

        const localCenter = new flock.BABYLON.Vector3(
          (localMin.x + localMax.x) / 2,
          (localMin.y + localMax.y) / 2,
          (localMin.z + localMax.z) / 2,
        );

        const shrinkAmount = 0.01;
        const adjustedHeight = Math.max(0, height - shrinkAmount);

        sourceCap = {
          radius,
          height: adjustedHeight,
          localCenter,
          baseY: localCenter.y - adjustedHeight / 2,
        };
        md.physicsCapsule = sourceCap;
      }

      // Evaluate problem criteria (also used for non-capsule normalization path)
      const groundCheckDistanceForEval = 0.3;
      const diameterToHeightRatio =
        sourceCap.height > 0
          ? (2 * sourceCap.radius) / sourceCap.height
          : Infinity;
      const probeRatio =
        groundCheckDistanceForEval / Math.max(sourceCap.height * 0.5, 0.001);

      const reasons = [];
      if (diameterToHeightRatio > 1.1) {
        reasons.push("sphere_like_capsule_severe");
      } else if (diameterToHeightRatio > 0.9) {
        reasons.push("sphere_like_capsule_warning");
      }
      if (sourceCap.radius > 1.0) reasons.push("radius_large_for_player");
      if (probeRatio < 0.35) reasons.push("ground_probe_too_short_for_capsule");

      const problematicCapsule = reasons.length > 0;
      const mustReplaceBecauseNonCapsule = !isCapsuleShape;
      const shouldReplace = mustReplaceBecauseNonCapsule || problematicCapsule;

      if (shouldReplace) {
        md._originalPhysicsShapeType =
          shape?.constructor?.name || "UNKNOWN_SHAPE";
        md._originalPhysicsCapsule = { ...sourceCap };

        // Use the same fallback profile as problem-case fix
        const fallbackRadius = Math.max(
          0.25,
          Math.min(0.5, sourceCap.radius * 0.35),
        );
        const fallbackHeight = Math.max(1.6, fallbackRadius * 3.5);

        const shrinkAmount = 0.01;
        const adjustedFallbackHeight = Math.max(
          0,
          fallbackHeight - shrinkAmount,
        );
        const fallbackHalfSeg = Math.max(
          0.001,
          adjustedFallbackHeight * 0.5 - fallbackRadius,
        );

        // X/Z from bbox center (project convention)
        model.computeWorldMatrix(true);
        const bb = model.getBoundingInfo().boundingBox;
        const localMin = bb.minimum;
        const localMax = bb.maximum;
        const bboxCenter = new flock.BABYLON.Vector3(
          (localMin.x + localMax.x) / 2,
          (localMin.y + localMax.y) / 2,
          (localMin.z + localMax.z) / 2,
        );

        // Preserve original base alignment for Y
        const rawLocalCenter =
          sourceCap.localCenter || new flock.BABYLON.Vector3(0, 0, 0);
        const originalBaseY =
          typeof sourceCap.baseY === "number"
            ? sourceCap.baseY
            : rawLocalCenter.y - sourceCap.height * 0.5;
        const fallbackCenterY = originalBaseY + adjustedFallbackHeight * 0.5;

        const centerX = bboxCenter.x;
        const centerZ = bboxCenter.z;

        const pointA = new flock.BABYLON.Vector3(
          centerX,
          fallbackCenterY - fallbackHalfSeg,
          centerZ,
        );
        const pointB = new flock.BABYLON.Vector3(
          centerX,
          fallbackCenterY + fallbackHalfSeg,
          centerZ,
        );

        const fallbackShape = new flock.BABYLON.PhysicsShapeCapsule(
          pointA,
          pointB,
          fallbackRadius,
          scene,
        );

        model.physics.shape = fallbackShape;

        md.physicsCapsule = {
          ...sourceCap,
          radius: fallbackRadius,
          height: adjustedFallbackHeight,
          localCenter: new flock.BABYLON.Vector3(
            centerX,
            fallbackCenterY,
            centerZ,
          ),
          baseY: originalBaseY,
        };

        md._usedFallbackLocomotionCapsule = true;
        md._capsuleProblemReasons = reasons;

        console.warn("[moveForward] Locomotion capsule applied", {
          model: model.name,
          replacedNonCapsule: mustReplaceBecauseNonCapsule,
          problematicCapsule,
          reasons,
          originalShapeType: md._originalPhysicsShapeType,
          originalCapsule: md._originalPhysicsCapsule,
          fallbackCapsule: md.physicsCapsule,
        });
      } else {
        md._usedFallbackLocomotionCapsule = false;
      }
    }

    const cap = md.physicsCapsule;
    if (
      !cap ||
      typeof cap.radius !== "number" ||
      typeof cap.height !== "number"
    ) {
      return;
    }

    const capsuleRadius = cap.radius;
    const capsuleHeightBottomOffset = Math.max(
      0.001,
      cap.height * 0.5 - capsuleRadius,
    );

    // --- Tunables ---
    const maxSlopeAngleDeg = 45;
    const groundCheckDistance = 0.3;
    const coyoteTimeMs = 120;
    const airControlFactor = 0.0;
    const airDragPerTick = 0.9;
    const stepHeight = 0.3;
    const stepProbeDistance = 0.6;
    const maxVerticalVelocity = 3.0;

    // Desired horizontal direction from camera
    const cameraForward = scene.activeCamera.getForwardRay().direction;
    const horizontalForward = new flock.BABYLON.Vector3(
      cameraForward.x,
      0,
      cameraForward.z,
    ).normalize();
    const desiredHorizontalVelocity = horizontalForward.scale(speed);

    // Grounded check
    const groundCheckStart = model.position.clone();
    const groundCheckEnd = groundCheckStart.add(
      new flock.BABYLON.Vector3(0, -groundCheckDistance, 0),
    );

    const physicsEngine = scene.getPhysicsEngine();
    if (!physicsEngine) return;
    const havokPlugin = physicsEngine.getPhysicsPlugin();

    const lc = cap.localCenter || flock.BABYLON.Vector3.Zero();
    const groundQuery = {
      shape: new flock.BABYLON.PhysicsShapeCapsule(
        new flock.BABYLON.Vector3(lc.x, lc.y - capsuleHeightBottomOffset, lc.z),
        new flock.BABYLON.Vector3(lc.x, lc.y + capsuleHeightBottomOffset, lc.z),
        capsuleRadius,
        scene,
      ),
      rotation: model.rotationQuaternion || flock.BABYLON.Quaternion.Identity(),
      startPosition: groundCheckStart,
      endPosition: groundCheckEnd,
      shouldHitTriggers: false,
      ignoredBodies: [],
      collisionFilterGroup: -1,
      collisionFilterMask: -1,
    };

    const groundResult = new flock.BABYLON.ShapeCastResult();
    const groundHitResult = new flock.BABYLON.ShapeCastResult();
    havokPlugin.shapeCast(groundQuery, groundResult, groundHitResult);

    let grounded = false;
    if (groundResult.hasHit) {
      const n = groundResult.hitNormalWorld;
      if (n) {
        const dot = flock.BABYLON.Vector3.Dot(n.normalize(), up);
        const clampedDot = Math.min(Math.max(dot, -1), 1);
        const angleDeg = (Math.acos(clampedDot) * 180) / Math.PI;
        grounded = angleDeg <= maxSlopeAngleDeg;
      } else {
        grounded = true;
      }
    }

    // Coyote
    const nowMs =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    if (grounded) model._lastGroundedAt = nowMs;
    const withinCoyoteTime = model._lastGroundedAt
      ? nowMs - model._lastGroundedAt <= coyoteTimeMs
      : false;

    // Horizontal policy
    const currentVelocity = model.physics.getLinearVelocity();
    const currentHorizontalVelocity = new flock.BABYLON.Vector3(
      currentVelocity.x,
      0,
      currentVelocity.z,
    );

    let appliedHorizontalVelocity;
    if (grounded || withinCoyoteTime) {
      appliedHorizontalVelocity = desiredHorizontalVelocity;
    } else {
      appliedHorizontalVelocity =
        currentHorizontalVelocity.scale(airDragPerTick);
      if (airControlFactor > 0) {
        appliedHorizontalVelocity = appliedHorizontalVelocity.add(
          desiredHorizontalVelocity.scale(airControlFactor),
        );
      }
    }

    // Step-up
    if (grounded || withinCoyoteTime) {
      const probeStartLow = model.position.add(
        new flock.BABYLON.Vector3(0, 0.05, 0),
      );
      const probeEndLow = probeStartLow.add(
        horizontalForward.scale(stepProbeDistance),
      );
      const probeStartHigh = probeStartLow.add(
        new flock.BABYLON.Vector3(0, stepHeight + 0.1, 0),
      );
      const probeEndHigh = probeStartHigh.add(
        horizontalForward.scale(stepProbeDistance),
      );

      const stepProbeQueryLow = {
        shape: new flock.BABYLON.PhysicsShapeSphere(
          new flock.BABYLON.Vector3(0, 0, 0),
          capsuleRadius * 0.8,
          scene,
        ),
        rotation: flock.BABYLON.Quaternion.Identity(),
        startPosition: probeStartLow,
        endPosition: probeEndLow,
        shouldHitTriggers: false,
        ignoredBodies: [],
        collisionFilterGroup: -1,
        collisionFilterMask: -1,
      };
      const stepProbeQueryHigh = {
        ...stepProbeQueryLow,
        startPosition: probeStartHigh,
        endPosition: probeEndHigh,
      };

      const lowResult = new flock.BABYLON.ShapeCastResult();
      const lowHitResult = new flock.BABYLON.ShapeCastResult();
      havokPlugin.shapeCast(stepProbeQueryLow, lowResult, lowHitResult);

      if (lowResult.hasHit) {
        const highResult = new flock.BABYLON.ShapeCastResult();
        const highHitResult = new flock.BABYLON.ShapeCastResult();
        havokPlugin.shapeCast(stepProbeQueryHigh, highResult, highHitResult);
        if (!highResult.hasHit) {
          const lastStepBoost = model._lastStepBoost || 0;
          if (nowMs - lastStepBoost > 400) {
            model._lastStepBoost = nowMs;
            const boostedVelocity = new flock.BABYLON.Vector3(
              appliedHorizontalVelocity.x,
              Math.max(currentVelocity.y, 2.5),
              appliedHorizontalVelocity.z,
            );
            model.physics.setLinearVelocity(boostedVelocity);
            return;
          }
        }
      }
    }

    // Vertical clamp
    const clampedVertical = Math.min(
      Math.max(currentVelocity.y, -maxVerticalVelocity),
      maxVerticalVelocity,
    );

    const finalVelocity = new flock.BABYLON.Vector3(
      appliedHorizontalVelocity.x,
      clampedVertical,
      appliedHorizontalVelocity.z,
    );
    model.physics.setLinearVelocity(finalVelocity);

    // Face direction
    const horizontalSpeedSq = appliedHorizontalVelocity.lengthSquared();
    if (horizontalSpeedSq > 1e-6) {
      const facingDirection = appliedHorizontalVelocity.normalize();
      const targetRotation = flock.BABYLON.Quaternion.FromLookDirectionLH(
        facingDirection,
        up,
      );
      const currentRotation =
        model.rotationQuaternion || flock.BABYLON.Quaternion.Identity();
      const deltaRotation = targetRotation.multiply(
        currentRotation.conjugate(),
      );
      const deltaEuler = deltaRotation.toEulerAngles();
      model.physics.setAngularVelocity(
        new flock.BABYLON.Vector3(0, deltaEuler.y * 5, 0),
      );
    }

    if (!model.rotationQuaternion) {
      model.rotationQuaternion = flock.BABYLON.Quaternion.RotationYawPitchRoll(
        model.rotation.y,
        model.rotation.x,
        model.rotation.z,
      );
    }
    model.rotationQuaternion.x = 0;
    model.rotationQuaternion.z = 0;
    model.rotationQuaternion.normalize();

    model.isGrounded = grounded;
  },
  moveSideways(modelName, speed) {
    const model = flock.scene.getMeshByName(modelName);
    if (!model || speed === 0) return;

    flock.ensureVerticalConstraint(model);

    const sidewaysSpeed = speed;

    // Get the camera's right direction vector (perpendicular to the forward direction)
    const cameraRight = flock.scene.activeCamera
      .getDirection(flock.BABYLON.Vector3.Right())
      .normalize();

    const moveDirection = cameraRight.scale(sidewaysSpeed);
    const currentVelocity = model.physics.getLinearVelocity();

    // Set linear velocity in the sideways direction
    model.physics.setLinearVelocity(
      new flock.BABYLON.Vector3(
        moveDirection.x,
        currentVelocity.y, // Keep Y velocity (no vertical movement)
        moveDirection.z,
      ),
    );

    // Rotate the model to face the direction of movement
    const facingDirection =
      sidewaysSpeed <= 0
        ? new flock.BABYLON.Vector3(
            -cameraRight.x,
            0,
            -cameraRight.z,
          ).normalize() // Right
        : new flock.BABYLON.Vector3(
            cameraRight.x,
            0,
            cameraRight.z,
          ).normalize(); // Left

    const targetRotation = flock.BABYLON.Quaternion.FromLookDirectionLH(
      facingDirection,
      flock.BABYLON.Vector3.Up(),
    );

    const currentRotation = model.rotationQuaternion;
    const deltaRotation = targetRotation.multiply(currentRotation.conjugate());
    const deltaEuler = deltaRotation.toEulerAngles();

    // Apply angular velocity to smoothly rotate the player
    model.physics.setAngularVelocity(
      new flock.BABYLON.Vector3(0, deltaEuler.y * 5, 0),
    );

    // Normalize the model's rotation to avoid drift
    model.rotationQuaternion.x = 0;
    model.rotationQuaternion.z = 0;
    model.rotationQuaternion.normalize();
  },
  strafe(modelName, speed) {
    const model = flock.scene.getMeshByName(modelName);
    if (!model || speed === 0) return;

    const sidewaysSpeed = -speed;

    // Get the camera's right direction vector (perpendicular to the forward direction)
    const cameraRight = flock.scene.activeCamera
      .getForwardRay()
      .direction.cross(flock.BABYLON.Vector3.Up())
      .normalize();

    const moveDirection = cameraRight.scale(sidewaysSpeed);
    const currentVelocity = model.physics.getLinearVelocity();

    // Set linear velocity in the sideways direction (left or right)
    model.physics.setLinearVelocity(
      new flock.BABYLON.Vector3(
        moveDirection.x,
        currentVelocity.y,
        moveDirection.z,
      ),
    );
  },
  updateDynamicMeshPositions(scene, dynamicMeshes) {
    dynamicMeshes.forEach((mesh) => {
      mesh.physics.setCollisionCallbackEnabled(true);
      const observable = mesh.physics.getCollisionObservable();
      observable.add((collisionEvent) => {
        const penetration = Math.abs(collisionEvent.distance);
        // If the penetration is extremely small (indicating minor clipping)
        if (penetration < 0.001) {
          // Read the current vertical velocity.
          const currentVel = mesh.physics.getLinearVelocity();
          // If there is an upward impulse being applied by the solver,
          // override it by setting the vertical velocity to zero.
          if (currentVel.y > 0) {
            mesh.physics.setLinearVelocity(
              new flock.BABYLON.Vector3(currentVel.x, 0, currentVel.z),
            );
            /*console.log(
              "Collision callback: small penetration detected. Overriding upward velocity.",
            );*/
          }

          dynamicMeshes.forEach((mesh) => {
            // Use a downward ray to determine the gap to the ground.
            const capsuleHalfHeight = 1; // adjust as needed
            const rayOrigin = mesh.position
              .clone()
              .add(new flock.BABYLON.Vector3(0, -capsuleHalfHeight, 0));
            const downRay = new flock.BABYLON.Ray(
              rayOrigin,
              new flock.BABYLON.Vector3(0, -1, 0),
              3,
            );
            const hit = scene.pickWithRay(downRay, (m) =>
              m.name.toLowerCase().includes("ground"),
            );
            if (hit && hit.pickedMesh) {
              const groundY = hit.pickedPoint.y;
              const capsuleBottomY = mesh.position.y - capsuleHalfHeight;
              const gap = capsuleBottomY - groundY;
              // If the gap is very small (i.e. the capsule is on or nearly on the ground)
              // and the vertical velocity is upward, override it.
              const currentVel = mesh.physics.getLinearVelocity();
              if (Math.abs(gap) < 0.1 && currentVel.y > 0) {
                mesh.physics.setLinearVelocity(
                  new flock.BABYLON.Vector3(currentVel.x, 0, currentVel.z),
                );
                //console.log("After-render: resetting upward velocity");
              }
            }
          });
        }
      });
    });
  },
};
